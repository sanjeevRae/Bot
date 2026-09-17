const supabaseAdmin = require('../lib/supabase');
// Loaded lazily so HTML rendering keeps working even if pdfkit is missing.
let PDFDocument = null;
function pdfLib() {
  if (PDFDocument === null) {
    try { PDFDocument = require('pdfkit'); } catch { PDFDocument = false; }
  }
  return PDFDocument || null;
}

/**
 * Invoice helpers: totals, amount in words, invoice numbering and the printable
 * HTML document. The same HTML is used for the admin preview and the email, so
 * what the team approves is exactly what the customer receives.
 */

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  return n % 10 ? t + ' ' + ONES[n % 10] : t;
}

function threeDigits(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? ONES[h] + ' Hundred' : '', rest ? twoDigits(rest) : ''].filter(Boolean).join(' ');
}

/** Nepali/Indian numbering: crore, lakh, thousand, hundred. */
function amountInWords(amount) {
  const value = Math.abs(Number(amount) || 0);
  const whole = Math.floor(value);
  const paisa = Math.round((value - whole) * 100);
  let words = 'Zero';
  if (whole > 0) {
    const crore = Math.floor(whole / 10000000);
    const lakh = Math.floor((whole % 10000000) / 100000);
    const thousand = Math.floor((whole % 100000) / 1000);
    const rest = whole % 1000;
    const bits = [];
    if (crore) bits.push(threeDigits(crore) + ' Crore');
    if (lakh) bits.push(twoDigits(lakh) + ' Lakh');
    if (thousand) bits.push(twoDigits(thousand) + ' Thousand');
    if (rest) bits.push(threeDigits(rest));
    words = bits.join(' ');
  }
  let out = 'Rupees ' + words;
  if (paisa) out += ' and ' + twoDigits(paisa) + ' Paisa';
  return out + ' Only';
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Qty x Rate fills Amount; totals exclude any tax by design. */
function normalizeItems(items) {
  return (Array.isArray(items) ? items : []).map((it, i) => {
    const qty = it.qty === '' || it.qty === undefined || it.qty === null ? 1 : Number(it.qty) || 0;
    const rate = Number(it.rate) || 0;
    const amount = it.amount === '' || it.amount === undefined || it.amount === null
      ? round2(qty * rate)
      : round2(it.amount);
    return { ...it, sn: i + 1, qty, rate: round2(rate), amount };
  });
}

function computeTotals(items, discount, serviceCharge) {
  const list = normalizeItems(items);
  const subtotal = round2(list.reduce((s, it) => s + it.amount, 0));
  const total = round2(subtotal - (Number(discount) || 0) + (Number(serviceCharge) || 0));
  return { items: list, subtotal, total };
}

/** Sequential number per year: INV-2026-0001 */
async function nextInvoiceNo() {
  const prefix = 'INV-' + new Date().getFullYear() + '-';
  // Highest number in use (zero-padded, so lexical order is numeric order).
  // Deriving from the maximum rather than a row count keeps numbers unique even
  // after an invoice is deleted.
  const { data: latest } = await supabaseAdmin
    .from('invoices')
    .select('invoice_no')
    .like('invoice_no', prefix + '%')
    .order('invoice_no', { ascending: false })
    .limit(1);
  let seq = 1;
  if (latest && latest[0] && latest[0].invoice_no) {
    const parsed = parseInt(String(latest[0].invoice_no).slice(prefix.length), 10);
    if (Number.isFinite(parsed)) seq = parsed + 1;
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = prefix + String(seq).padStart(4, '0');
    const { data } = await supabaseAdmin.from('invoices').select('id').eq('invoice_no', candidate).maybeSingle();
    if (!data) return candidate;
    seq++;
  }
  return prefix + String(Date.now()).slice(-6);
}

const money = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ---------------- HTML document ---------------- */

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const nl2br = (v) => esc(v).replace(/\n/g, '<br/>');
const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';

/** A label/value line that disappears when there is nothing to show. */
function detail(label, value, opts = {}) {
  if (!has(value)) return '';
  return '<div style="margin:1px 0;font-size:12px;line-height:1.6">'
    + '<span style="color:#6b7280">' + esc(label) + ': </span>'
    + '<span style="color:#111827;' + (opts.bold ? 'font-weight:600' : '') + '">' + esc(value) + '</span></div>';
}

function renderHeader(company, inv) {
  const logo = has(company.logoUrl)
    ? '<img src="' + esc(company.logoUrl) + '" alt="" width="64" height="64" style="width:64px;height:64px;object-fit:contain;border-radius:8px;display:block" />'
    : '<div style="width:64px;height:64px;border-radius:8px;background:#059669;color:#fff;font-size:26px;font-weight:700;display:flex;align-items:center;justify-content:center">C</div>';

  const companyLines = [
    has(company.address) ? nl2br(company.address) : '',
    [company.phone, company.email].filter(has).map(esc).join('  |  '),
    [company.website].filter(has).map(esc).join(''),
    [[company.regNo ? 'Reg. No.: ' + company.regNo : '', company.tpin ? 'TPIN: ' + company.tpin : '']
      .filter(has).map(esc).join('  |  ')],
  ].filter((l) => Array.isArray(l) ? l.some(has) : has(l)).map((l) => (Array.isArray(l) ? l[0] : l)).filter(has);

  const meta = [
    ['Invoice No.', inv.invoiceNo],
    ['Transaction Date', inv.transactionDate],
    ['Reprint Date', inv.reprintDate],
    ['Copy', inv.copyStatus],
  ].filter(([, v]) => has(v));

  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-bottom:2px solid #111827;padding-bottom:12px">'
    + '<tr>'
    + '<td style="width:64px;vertical-align:top;padding:0 14px 14px 0">' + logo + '</td>'
    + '<td style="vertical-align:top;padding:0 14px 14px 0">'
    + '<div style="font-size:19px;font-weight:700;letter-spacing:-0.01em;color:#111827">' + esc(company.name || 'Company') + '</div>'
    + companyLines.map((l) => '<div style="font-size:11.5px;line-height:1.6;color:#4b5563">' + l + '</div>').join('')
    + '</td>'
    + '<td style="vertical-align:top;text-align:right;padding:0 0 14px 0;white-space:nowrap">'
    + meta.map(([k, v]) => '<div style="font-size:11.5px;line-height:1.7;color:#4b5563">' + esc(k) + ': '
        + '<span style="color:#111827;font-weight:600">' + esc(v) + '</span></div>').join('')
    + '</td>'
    + '</tr></table>';
}

function renderCustomer(customer) {
  const rows = [
    detail('Name', customer.name, { bold: true }),
    detail('Customer ID / Username', customer.customerId),
    detail('Billing Address', customer.address),
    detail('Phone', customer.phone),
    detail('Customer TPIN', customer.tpin),
    detail('Customer PAN', customer.panNo),
    detail('Email', customer.email),
  ].join('');
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:16px">'
    + '<tr><td style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px">'
    + '<div style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#6b7280;margin-bottom:6px">Bill To</div>'
    + (rows || '<div style="font-size:12px;color:#9ca3af">-</div>')
    + '</td></tr></table>';
}
function renderItemsTable(items) {
  const th = (label, align) => '<th style="background:#f3f4f6;border:1px solid #e5e7eb;padding:8px 9px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#374151;text-align:' + align + '">' + esc(label) + '</th>';
  const td = (content, align) => '<td style="border:1px solid #e5e7eb;padding:9px;font-size:11.5px;color:#111827;vertical-align:top;text-align:' + align + '">' + content + '</td>';

  const body = (items || []).map((it) => {
    const sub = [
      ['Package', it.packageName],
      ['Plan', it.plan],
      ['Billing period', it.billingPeriod],
      ['Effective from', it.effectiveDate],
    ].filter((pair) => has(pair[1]))
      .map((pair) => '<div style="font-size:10px;line-height:1.55;color:#6b7280">' + esc(pair[0]) + ': <span style="color:#374151">' + esc(pair[1]) + '</span></div>')
      .join('');
    return '<tr>'
      + td(esc(it.sn), 'center')
      + td(has(it.panNo) ? esc(it.panNo) : '-', 'center')
      + td('<div style="font-weight:600">' + esc(it.particulars || '') + '</div>' + sub, 'left')
      + td(has(it.description) ? nl2br(it.description) : '', 'left')
      + td(esc(it.qty), 'center')
      + td(money(it.rate), 'right')
      + td(money(it.amount), 'right')
      + '</tr>';
  }).join('');

  const emptyRow = '<tr>' + td('<span style="color:#9ca3af">No items yet</span>', 'left') + td('', 'center') + td('', 'left') + td('', 'left') + td('', 'center') + td('', 'right') + td('', 'right') + '</tr>';

  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:18px">'
    + '<thead><tr>'
    + th('S.N.', 'center') + th('PAN No', 'center') + th('Particulars', 'left') + th('Description', 'left')
    + th('Quantity', 'center') + th('Rate', 'right') + th('Amount', 'right')
    + '</tr></thead><tbody>' + (body || emptyRow) + '</tbody></table>';
}

function renderSummary(inv, totals) {
  const line = (label, value, strong) => '<tr>'
    + '<td style="padding:6px 10px;font-size:12px;color:#4b5563;text-align:right">' + esc(label) + '</td>'
    + '<td style="padding:6px 10px;width:130px;white-space:nowrap;text-align:right;color:#111827;font-size:' + (strong ? '14px' : '12px') + ';font-weight:' + (strong ? '700' : '600') + '">' + value + '</td></tr>';
  const discount = Number(inv.discount) || 0;
  const service = Number(inv.serviceCharge) || 0;
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:14px;margin-left:auto;min-width:290px">'
    + line('Subtotal', 'Rs. ' + money(totals.subtotal))
    + (discount ? line('Discount', '- Rs. ' + money(discount)) : '')
    + (service ? line('Service charge', 'Rs. ' + money(service)) : '')
    + '<tr><td colspan="2" style="border-top:1px solid #e5e7eb;padding:0"></td></tr>'
    + line('Total Amount', 'Rs. ' + money(totals.total), true)
    + '</table>';
}

function renderPayment(inv, company) {
  const lines = [
    has(inv.totalInWords) ? '<div style="font-size:12px;line-height:1.7;color:#111827"><span style="color:#6b7280">Amount in words: </span><span style="font-weight:600">' + esc(inv.totalInWords) + '</span></div>' : '',
    detail('Payment mode', inv.paymentMode),
    detail('Payment reference', inv.paymentRef),
    detail('Due date', inv.dueDate),
  ].filter(Boolean).join('');
  const qrUrl = has(inv.paymentQrUrl) ? inv.paymentQrUrl : company.paymentQrUrl;
  const qr = has(qrUrl)
    ? '<img src="' + esc(qrUrl) + '" alt="Payment QR" width="104" height="104" style="width:104px;height:104px;object-fit:contain;border:1px solid #e5e7eb;border-radius:8px;display:block" />'
    : '';
  const notes = [company.bankDetails, company.paymentInstructions].filter(has)
    .map((t) => '<div style="font-size:11px;line-height:1.7;color:#4b5563">' + nl2br(t) + '</div>').join('');
  if (!lines && !qr && !notes) return '';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:16px">'
    + '<tr><td style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px">'
    + '<div style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#6b7280;margin-bottom:6px">Payment Details</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>'
    + '<td style="vertical-align:top">' + lines + notes + '</td>'
    + (qr ? '<td style="vertical-align:top;text-align:right;width:116px">' + qr + '</td>' : '')
    + '</tr></table>'
    + '</td></tr></table>';
}

function renderFooter(inv, company) {
  const stamp = has(company.stampUrl)
    ? '<img src="' + esc(company.stampUrl) + '" alt="" width="90" height="90" style="width:90px;height:90px;object-fit:contain;display:block" />'
    : '';
  const sign = has(company.signatureUrl)
    ? '<img src="' + esc(company.signatureUrl) + '" alt="" width="120" height="40" style="width:120px;height:40px;object-fit:contain;display:block;margin-bottom:2px" />'
    : '<div style="height:40px"></div>';
  const terms = has(inv.terms) ? '<div style="font-size:11px;line-height:1.7;color:#4b5563">' + nl2br(inv.terms) + '</div>' : '';
  const notes = has(inv.notes) ? '<div style="font-size:11px;line-height:1.7;color:#4b5563">' + nl2br(inv.notes) + '</div>' : '';

  return (terms || notes ? '<div style="margin-top:16px;border-top:1px solid #e5e7eb;padding-top:10px">'
      + (notes ? '<div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#6b7280;margin-bottom:3px">Notes</div>' + notes : '')
      + (terms ? '<div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#6b7280;margin:8px 0 3px">Terms</div>' + terms : '')
      + '</div>' : '')
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:24px">'
    + '<tr>'
    + '<td style="vertical-align:bottom;width:50%">' + sign
    + '<div style="border-top:1px solid #9ca3af;padding-top:5px;font-size:11px;color:#4b5563;max-width:220px">Authorised Signature</div>'
    + '<div style="font-size:11px;font-weight:600;color:#111827;margin-top:2px">' + esc(company.name || '') + '</div>'
    + '</td>'
    + '<td style="vertical-align:bottom;text-align:right;width:50%">' + stamp
    + '<div style="font-size:10px;color:#9ca3af">Company Stamp</div>'
    + '</td>'
    + '</tr></table>'
    + '<div style="margin-top:16px;border-top:1px solid #e5e7eb;padding-top:9px;text-align:center">'
    + '<div style="font-size:10px;color:#6b7280">' + esc(company.footerNote || '') + '</div>'
    + (has(company.thankYou) ? '<div style="font-size:11px;color:#111827;font-weight:600;margin-top:3px">' + esc(company.thankYou) + '</div>' : '')
    + '</div>';
}
/**
 * Full standalone HTML document. Used for the admin preview AND the email, so
 * what the team approves is exactly what the customer receives.
 */
function renderInvoiceHtml(inv) {
  const company = inv.company || {};
  const { items, subtotal, total } = computeTotals(inv.items, inv.discount, inv.serviceCharge);
  const invoice = {
    ...inv,
    invoiceNo: inv.invoiceNo || '',
    copyStatus: inv.copyStatus || 'Original',
    customer: inv.customer || {},
    totalInWords: has(inv.totalInWords) ? inv.totalInWords : amountInWords(total),
  };

  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"/>'
    + '<title>' + esc(company.name || 'Invoice') + ' ' + esc(invoice.invoiceNo) + '</title>'
    + '<style>'
    + 'body{margin:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}'
    + '.sheet{max-width:820px;margin:0 auto;background:#fff;padding:32px 34px;box-sizing:border-box}'
    + '.inv-title{text-align:center;font-size:22px;font-weight:700;letter-spacing:0.34em;text-transform:uppercase;color:#111827;margin:22px 0 0;padding:9px 0;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb}'
    + '@media print{body{background:#fff}.sheet{max-width:none;padding:0;margin:0}@page{size:A4;margin:12mm}}'
    + '</style></head><body><div class="sheet">'
    + renderHeader(company, invoice)
    + '<div class="inv-title">Invoice</div>'
    + renderCustomer(invoice.customer)
    + renderItemsTable(items)
    + renderSummary(invoice, { subtotal, total })
    + renderPayment(invoice, company)
    + renderFooter(invoice, company)
    + '</div></body></html>';
}
/**
 * Real A4 PDF of the same invoice, so the customer receives a proper
 * attachment instead of only a web page in the email body.
 * Returns a Buffer, or null when pdfkit is not installed.
 */
function buildInvoicePdf(inv) {
  const Lib = pdfLib();
  if (!Lib) return null;
  const doc = new Lib({ size: 'A4', margin: 36, bufferPages: true });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const company = inv.company || {};
  const customer = inv.customer || {};
  const items = normalizeItems(inv.items);
  const totals = computeTotals(items, inv.discount, inv.serviceCharge);
  const words = has(inv.totalInWords) ? inv.totalInWords : amountInWords(totals.total);
  const ink = '#111827';
  const muted = '#6b7280';
  const hair = '#e5e7eb';
  const pageW = doc.page.width;
  const L = doc.page.margins.left;
  const R = pageW - doc.page.margins.right;
  const W = R - L;
  const bottom = doc.page.height - 50;

  const need = (h) => { if (doc.y + h > bottom) doc.addPage(); };
  const label = (str, x, y, w, align) => {
    doc.fillColor(muted).font('Helvetica').fontSize(8.5).text(str, x, y, { width: w, align: align || 'left' });
  };
  const strong = (str, x, y, w, align, size) => {
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(size || 9).text(str, x, y, { width: w, align: align || 'left' });
  };
  const para = (str, x, y, w, opts) => {
    doc.fillColor(ink).font('Helvetica').fontSize(opts && opts.size ? opts.size : 9).text(String(str), x, y, { width: w, lineGap: 1.5 });
    return doc.y;
  };

  // ---------- header ----------
  const top = 40;
  const logoIsUrl = typeof company.logoUrl === 'string' && /^https?:\/\//.test(company.logoUrl);
  let drewLogo = false;
  if (logoIsUrl) {
    try { doc.image(company.logoUrl, L, top, { fit: [52, 52] }); drewLogo = true; } catch { drewLogo = false; }
  }
  if (!drewLogo) {
    doc.roundedRect(L, top, 52, 52, 8).fill('#059669');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(24).text('C', L, top + 13, { width: 52, align: 'center' });
  }
  const cx = L + 66;
  doc.fillColor(ink).font('Helvetica-Bold').fontSize(15).text(company.name || 'Company', cx, top);
  let cy = top + 19;
  doc.font('Helvetica').fontSize(8);
  [company.address,
    [company.phone, company.email].filter(has).join('  |  '),
    company.website,
    [company.regNo ? 'Reg. No.: ' + company.regNo : '', company.tpin ? 'TPIN: ' + company.tpin : ''].filter(has).join('  |  '),
  ].filter(has).forEach((line) => {
    doc.fillColor(muted).text(line, cx, cy, { width: 300 });
    cy += 11;
  });
  const meta = [
    ['Invoice No.', inv.invoiceNo],
    ['Transaction Date', inv.transactionDate],
    ['Reprint Date', inv.reprintDate],
    ['Copy', inv.copyStatus],
  ].filter((p) => has(p[1]));
  let my = top + 2;
  meta.forEach((p) => {
    label(p[0] + ': ', R - 150, my, 150, 'left');
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(8.5).text(String(p[1]), R - 60, my, { width: 60, align: 'right' });
    doc.font('Helvetica');
    my += 13;
  });
  const ruleY = Math.max(cy, my) + 6;
  doc.moveTo(L, ruleY).lineTo(R, ruleY).lineWidth(1.3).strokeColor(ink).stroke();
  doc.y = ruleY + 12;

  // ---------- INVOICE title ----------
  doc.fillColor(ink).font('Helvetica-Bold').fontSize(14).text('INVOICE', L, doc.y, { width: W, align: 'center', characterSpacing: 5 });
  doc.moveTo(L, doc.y + 3).lineTo(R, doc.y + 3).lineWidth(0.6).strokeColor('#9ca3af').stroke();
  doc.y += 14;

  // ---------- customer ----------
  const custLines = [
    [customer.name, true],
    [customer.customerId ? 'Customer ID / Username: ' + customer.customerId : '', false],
    [customer.address, false],
    [customer.phone ? 'Phone: ' + customer.phone : '', false],
    [customer.tpin ? 'Customer TPIN: ' + customer.tpin : '', false],
    [customer.panNo ? 'Customer PAN: ' + customer.panNo : '', false],
    [customer.email, false],
  ].filter((p) => has(p[0]));
  const custH = 26 + custLines.reduce((h, p) => h + (p[1] ? 13 : 11), 0);
  need(custH);
  const cY = doc.y;
  doc.roundedRect(L, cY, W, custH, 6).fill('#f9fafb');
  doc.roundedRect(L, cY, W, custH, 6).lineWidth(0.8).strokeColor(hair).stroke();
  let ty = cY + 9;
  label('BILL TO', L + 12, ty); ty += 13;
  custLines.forEach((p) => {
    if (p[1]) strong(p[0], L + 12, ty, W - 24, 'left', 10);
    else label(p[0], L + 12, ty, W - 24);
    ty += p[1] ? 13 : 11;
  });
  doc.y = cY + custH + 12;

  // ---------- items table ----------
  const cols = [
    { key: 'sn', title: 'S.N.', w: 26, align: 'center' },
    { key: 'panNo', title: 'PAN No', w: 62, align: 'center' },
    { key: 'particulars', title: 'Particulars', w: 168, align: 'left' },
    { key: 'description', title: 'Description', w: 116, align: 'left' },
    { key: 'qty', title: 'Qty', w: 30, align: 'center' },
    { key: 'rate', title: 'Rate', w: 56, align: 'right' },
    { key: 'amount', title: 'Amount', w: 65, align: 'right' },
  ];
  const totalW = cols.reduce((s, c) => s + c.w, 0);
  const scale = W / totalW;
  cols.forEach((c) => { c.w = Math.floor(c.w * scale); c.x = 0; });
  let ax = L;
  cols.forEach((c) => { c.x = ax; ax += c.w; });

  const rowHeight = (row) => {
    const sub = [
      row.packageName ? 'Package: ' + row.packageName : '',
      row.plan ? 'Plan: ' + row.plan : '',
      row.billingPeriod ? 'Billing period: ' + row.billingPeriod : '',
      row.effectiveDate ? 'Effective from: ' + row.effectiveDate : '',
    ].filter(has).join('\n');
    const left1 = doc.heightOfString(String(row.particulars || '') + (sub ? '\n' + sub : ''), { width: cols[2].w - 10, fontSize: 8 });
    const left2 = doc.heightOfString(String(row.description || ''), { width: cols[3].w - 10, fontSize: 8 });
    return Math.max(20, Math.max(left1, left2) + 10);
  };

  const drawHead = () => {
    const h = 22;
    doc.rect(L, doc.y, W, h).fill('#f3f4f6');
    let x = L;
    cols.forEach((c) => {
      doc.fillColor('#374151').font('Helvetica-Bold').fontSize(7.5).text(c.title.toUpperCase(), c.x, doc.y + 7, { width: c.w, align: c.align === 'center' ? 'center' : c.align === 'right' ? 'right' : 'left' });
      doc.moveTo(x, doc.y).lineTo(x, doc.y + h).lineWidth(0.6).strokeColor(hair).stroke();
      x += c.w;
    });
    doc.moveTo(R, doc.y).lineTo(R, doc.y + h).lineWidth(0.6).strokeColor(hair).stroke();
    doc.moveTo(L, doc.y + h).lineTo(R, doc.y + h).lineWidth(0.6).strokeColor(hair).stroke();
    doc.y += h;
  };

  need(60);
  drawHead();
  items.forEach((row) => {
    const h = rowHeight(row);
    if (doc.y + h > bottom) { doc.addPage(); drawHead(); }
    const y0 = doc.y;
    doc.rect(L, y0, W, h).fill('#ffffff');
    const sub = [
      row.packageName ? 'Package: ' + row.packageName : '',
      row.plan ? 'Plan: ' + row.plan : '',
      row.billingPeriod ? 'Billing period: ' + row.billingPeriod : '',
      row.effectiveDate ? 'Effective from: ' + row.effectiveDate : '',
    ].filter(has).join('\n');
    const put = (str, col, opts) => {
      doc.fillColor(ink).font('Helvetica').fontSize(8).text(String(str), col.x + 5, y0 + 6, { width: col.w - 10, align: col.align, ...opts });
    };
    put(String(row.sn), cols[0]);
    put(has(row.panNo) ? row.panNo : '-', cols[1]);
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(8).text(String(row.particulars || ''), cols[2].x + 5, y0 + 6, { width: cols[2].w - 10 });
    if (sub) doc.fillColor(muted).font('Helvetica').fontSize(7).text(sub, cols[2].x + 5, doc.y, { width: cols[2].w - 10 });
    doc.font('Helvetica').fontSize(8);
    put(has(row.description) ? row.description : '', cols[3]);
    put(String(row.qty), cols[4]);
    put(money(row.rate), cols[5]);
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(8).text(money(row.amount), cols[6].x + 5, y0 + 6, { width: cols[6].w - 10, align: 'right' });
    let x = L;
    cols.forEach((c) => { doc.moveTo(x, y0).lineTo(x, y0 + h).lineWidth(0.6).strokeColor(hair).stroke(); x += c.w; });
    doc.moveTo(R, y0).lineTo(R, y0 + h).lineWidth(0.6).strokeColor(hair).stroke();
    doc.moveTo(L, y0 + h).lineTo(R, y0 + h).lineWidth(0.6).strokeColor(hair).stroke();
    doc.y = y0 + h;
  });

  // ---------- summary ----------
  const discount = Number(inv.discount) || 0;
  const service = Number(inv.serviceCharge) || 0;
  const sumRows = [];
  sumRows.push(['Subtotal', money(totals.subtotal), false]);
  if (discount) sumRows.push(['Discount', '- ' + money(discount), false]);
  if (service) sumRows.push(['Service charge', money(service), false]);
  sumRows.push(['Total Amount', 'Rs. ' + money(totals.total), true]);
  const sumH = 12 + sumRows.length * 16 + 8;
  need(sumH + 60);
  const sY = doc.y;
  const sumW = 220;
  const sumX = R - sumW;
  let ry = sY;
  sumRows.forEach((p) => {
    if (p[2]) { doc.moveTo(sumX, ry).lineTo(R, ry).lineWidth(0.8).strokeColor('#9ca3af').stroke(); ry += 5; }
    label(p[0], sumX, ry + 2, sumW - 80, 'right');
    strong(p[1], R - 76, ry, 76, 'right', p[2] ? 10.5 : 8.5);
    ry += p[2] ? 18 : 16;
  });
  doc.y = ry + 6;

  // ---------- words + payment ----------
  const payLines = [
    has(words) ? 'Amount in words: ' + words : '',
    inv.paymentMode ? 'Payment mode: ' + inv.paymentMode : '',
    inv.paymentRef ? 'Payment reference: ' + inv.paymentRef : '',
    inv.dueDate ? 'Due date: ' + inv.dueDate : '',
    company.bankDetails ? 'Bank: ' + company.bankDetails : '',
    company.paymentInstructions || '',
  ].filter(has);
  const qrIsUrl = typeof (inv.paymentQrUrl || company.paymentQrUrl) === 'string' && /^https?:\/\//.test(inv.paymentQrUrl || company.paymentQrUrl || '');
  const payH = 22 + payLines.reduce((h, t) => h + doc.heightOfString(t, { width: qrIsUrl ? W - 150 : W - 24, fontSize: 8 }) + 3, 0);
  if (payLines.length || qrIsUrl) {
    need(payH + 8);
    const pY = doc.y;
    doc.roundedRect(L, pY, W, payH, 6).fill('#f9fafb');
    doc.roundedRect(L, pY, W, payH, 6).lineWidth(0.8).strokeColor(hair).stroke();
    label('PAYMENT DETAILS', L + 12, pY + 8);
    let py = pY + 22;
    payLines.forEach((t) => { py = para(t, L + 12, py, qrIsUrl ? W - 150 : W - 24, { size: 8 }) + 3; });
    if (qrIsUrl) {
      try { doc.image(inv.paymentQrUrl || company.paymentQrUrl, R - 116, pY + 12, { fit: [104, 104] }); } catch { /* skip */ }
    }
    doc.y = pY + payH + 12;
  }

  // ---------- notes + terms ----------
  const ntBlocks = [];
  if (has(inv.notes)) ntBlocks.push(['NOTES', inv.notes]);
  if (has(inv.terms)) ntBlocks.push(['TERMS', inv.terms]);
  if (ntBlocks.length) {
    need(40);
    doc.moveTo(L, doc.y).lineTo(R, doc.y).lineWidth(0.6).strokeColor(hair).stroke();
    doc.y += 8;
    ntBlocks.forEach((b) => {
      label(b[0], L, doc.y);
      doc.y += 11;
      doc.y = para(b[1], L, doc.y, W, { size: 8 }) + 6;
    });
  }

  // ---------- signature + stamp ----------
  need(90);
  const sigY = Math.max(doc.y + 14, bottom - 74);
  const sig = has(company.signatureUrl);
  if (sig) { try { doc.image(company.signatureUrl, L, sigY - 42, { fit: [120, 40] }); } catch { /* skip */ } }
  doc.moveTo(L, sigY).lineTo(L + 180, sigY).lineWidth(0.8).strokeColor('#9ca3af').stroke();
  label('Authorised Signature', L, sigY + 4);
  strong(company.name || '', L, sigY + 15, 220);
  if (has(company.stampUrl)) {
    try { doc.image(company.stampUrl, R - 92, sigY - 58, { fit: [90, 90] }); } catch { /* skip */ }
  }
  label('Company Stamp', R - 92, sigY + 18, 92, 'center');

  // ---------- page footers ----------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fillColor(muted).font('Helvetica').fontSize(7)
      .text(company.footerNote || 'This is a computer-generated invoice.', L, doc.page.height - 34, { width: W, align: 'center', lineBreak: false });
    if (has(company.thankYou)) {
      doc.fillColor(ink).font('Helvetica-Bold').fontSize(7.5)
        .text(company.thankYou, L, doc.page.height - 23, { width: W, align: 'center', lineBreak: false });
    }
  }

  doc.end();
  return done;
}
/**
 * Short cover letter that introduces the attached PDF invoice, in the style
 * customers expect from a Nepali service provider.
 */
function renderInvoiceCoverLetter(inv, company) {
  const c = inv.customer || {};
  const name = has(c.name) ? c.name : 'Valued Customer';
  const brand = company.name || 'Chitra Tech';
  const logo = has(company.logoUrl)
    ? '<img src="' + esc(company.logoUrl) + '" alt="" width="32" height="32" style="border-radius:8px;display:block;object-fit:contain" />'
    : '<span style="background:#059669;color:#fff;width:32px;height:32px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-weight:700">C</span>';
  return '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">'
    + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">' + logo + '<strong style="font-size:15px;color:#111827">' + esc(brand) + '</strong></div>'
    + '<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#374151">Dear ' + esc(name) + ',</p>'
    + '<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#374151">Greetings from ' + esc(brand) + '!</p>'
    + '<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#374151">Please find attached the electronic invoice <strong>' + esc(inv.invoiceNo) + '</strong> against your payment for ' + esc(brand) + '. If you have any query, please contact our Accounts Section or write to us at ' + esc(company.email || '') + '.</p>'
    + '<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#374151">Thank you for your business.</p>'
    + '<p style="margin:0 0 2px;font-size:14px;line-height:1.6;color:#374151">Best regards,</p>'
    + '<p style="margin:0;font-size:14px;line-height:1.6;color:#374151">Customer Accounts Department,<br/>' + esc(brand) + '</p>'
    + '<p style="margin:14px 0 0;font-size:12px;color:#6b7280">Invoice ' + esc(inv.invoiceNo) + ' for Rs. ' + money(inv.total) + ' is attached as a PDF.</p>'
    + '</div>';
}
module.exports = { amountInWords, computeTotals, normalizeItems, nextInvoiceNo, money, round2, renderInvoiceHtml, buildInvoicePdf, renderInvoiceCoverLetter };