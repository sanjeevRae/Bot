const supabaseAdmin = require('../lib/supabase');

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
module.exports = { amountInWords, computeTotals, normalizeItems, nextInvoiceNo, money, round2, renderInvoiceHtml };