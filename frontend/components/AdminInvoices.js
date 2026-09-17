import { useState, useEffect, useCallback, useRef } from "react";
import { api, fetchApi, supabase } from "../lib/supabaseClient";

const INVOICE_STATUSES = ["draft", "sent", "paid", "cancelled"];
const INVOICE_STYLE = {
  draft: "border-gray-200 bg-gray-100 text-gray-600",
  sent: "border-blue-100 bg-blue-50 text-blue-700",
  paid: "border-emerald-100 bg-emerald-50 text-emerald-700",
  cancelled: "border-red-100 bg-red-50 text-red-600",
};
const money = (n) => "Rs. " + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** POST to an HTML endpoint with the admin token attached. */
async function authedHtml(path, body) {
  const { data } = await supabase.auth.getSession();
  const res = await fetchApi(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + (data && data.session ? data.session.access_token : ""),
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error("Could not render the preview");
  return res.text();
}

const Field = ({ label, value, onChange, type, placeholder }) => (
  <label className="block">
    <span className="mb-1 block text-[11px] font-medium text-ink-600">{label}</span>
    <input
      className="input-base !py-1.5 text-[13px]"
      type={type || "text"}
      value={value === null || value === undefined ? "" : value}
      placeholder={placeholder || ""}
      onChange={(e) => onChange(e.target.value)}
    />
  </label>
);

/**
 * Invoices tab. Raise an invoice from an order (or blank), edit every part of
 * it, watch the live preview, then print or email it to the customer.
 */
export default function AdminInvoices({ openId, onOpened }) {
  const [list, setList] = useState(null);
  const [draft, setDraft] = useState(null);
  const [preview, setPreview] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [showPreview, setShowPreview] = useState(true);
  const frameRef = useRef(null);

  const loadList = useCallback(async () => {
    try {
      const d = await api("/api/admin/invoices");
      setList(d.invoices || []);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  const openInvoice = useCallback(async (id) => {
    setBusy("load");
    setError("");
    setNotice("");
    try {
      const d = await api("/api/admin/invoices/" + id);
      setDraft(d.invoice);
    } catch (e) {
      setError(e.message);
    }
    setBusy("");
  }, []);

  useEffect(() => {
    if (openId) {
      openInvoice(openId);
      if (onOpened) onOpened();
    }
  }, [openId, openInvoice, onOpened]);

  /* Live preview: the backend renders the very HTML that gets emailed. */
  useEffect(() => {
    if (!draft) { setPreview(""); return undefined; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const html = await authedHtml("/api/admin/invoices/preview", draft);
        if (!cancelled) { setPreview(html); setPreviewError(""); }
      } catch (e) {
        if (!cancelled) setPreviewError(e.message);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [draft]);

  const up = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const upCustomer = (patch) => setDraft((d) => ({ ...d, customer: { ...(d.customer || {}), ...patch } }));
  const upItem = (i, patch) => setDraft((d) => ({
    ...d,
    items: (d.items || []).map((it, idx) => (idx === i ? { ...it, ...patch } : it)),
  }));
  const addItem = () => setDraft((d) => ({
    ...d,
    items: [...(d.items || []), { particulars: "", description: "", panNo: "", qty: 1, rate: 0, packageName: "", plan: "", billingPeriod: "", effectiveDate: "" }],
  }));
  const removeItem = (i) => setDraft((d) => ({ ...d, items: (d.items || []).filter((_, idx) => idx !== i) }));

  async function persist() {
    const d = await api("/api/admin/invoices/" + draft.id, { method: "PATCH", body: JSON.stringify(draft) });
    setDraft(d.invoice);
    return d.invoice;
  }

  async function save() {
    setBusy("save"); setError(""); setNotice("");
    try {
      await persist();
      setNotice("Invoice saved.");
      await loadList();
    } catch (e) { setError(e.message); }
    setBusy("");
  }

  async function send() {
    const to = (draft.customer || {}).email || "";
    if (!confirm("Email invoice " + draft.invoiceNo + " to " + (to || "the customer") + "?")) return;
    setBusy("send"); setError(""); setNotice("");
    try {
      await persist();
      const d = await api("/api/admin/invoices/" + draft.id + "/send", { method: "POST", body: "{}" });
      setNotice("Invoice emailed to " + d.to + " with the PDF attached.");
      const fresh = await api("/api/admin/invoices/" + draft.id);
      setDraft(fresh.invoice);
      await loadList();
    } catch (e) { setError(e.message); }
    setBusy("");
  }

  async function setStatus(status) {
    setBusy("status"); setError(""); setNotice("");
    try {
      const d = await api("/api/admin/invoices/" + draft.id, { method: "PATCH", body: JSON.stringify({ status }) });
      setDraft(d.invoice);
      setNotice("Invoice marked " + status + ".");
      await loadList();
    } catch (e) { setError(e.message); }
    setBusy("");
  }

  async function remove() {
    if (!confirm("Delete invoice " + draft.invoiceNo + "? This cannot be undone.")) return;
    setBusy("delete"); setError(""); setNotice("");
    try {
      await api("/api/admin/invoices/" + draft.id, { method: "DELETE" });
      setDraft(null);
      setNotice("Invoice deleted.");
      await loadList();
    } catch (e) { setError(e.message); }
    setBusy("");
  }

  function print() {
    const win = frameRef.current && frameRef.current.contentWindow;
    if (win) { win.focus(); win.print(); }
  }

  if (!draft) {
    return (
      <div>
        {error && <p className="mb-4 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}
        {notice && <p className="mb-4 rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}
        <div className="quiet-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-ink-400">
                <th className="px-4 py-3 font-medium">Invoice</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Business</th>
                <th className="px-4 py-3 font-medium">Total</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Open</th>
              </tr>
            </thead>
            <tbody>
              {(list || []).length === 0 && (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-ink-400">No invoices yet. Raise one from the Orders tab.</td></tr>
              )}
              {(list || []).map((inv) => (
                <tr key={inv.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-900/[0.015]">
                  <td className="px-4 py-3.5">
                    <div className="font-medium text-ink-900">{inv.invoiceNo}</div>
                    <div className="text-xs text-ink-400">{String(inv.createdAt || "").slice(0, 10)}</div>
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="text-ink-900">{inv.customerName || "-"}</div>
                    <div className="text-xs text-ink-400">{inv.customerEmail || "no email"}</div>
                  </td>
                  <td className="px-4 py-3.5 text-ink-500">{inv.business || "-"}</td>
                  <td className="px-4 py-3.5 text-ink-900">{money(inv.total)}</td>
                  <td className="px-4 py-3.5">
                    <span className={"inline-block rounded-full border px-2.5 py-0.5 text-[11px] font-medium capitalize " + (INVOICE_STYLE[inv.status] || INVOICE_STYLE.draft)}>
                      {inv.status}
                    </span>
                    {inv.sentAt && <div className="mt-1 text-[11px] text-ink-400">sent {String(inv.sentAt).slice(0, 10)}</div>}
                  </td>
                  <td className="px-4 py-3.5 text-right">
                    <button onClick={() => openInvoice(inv.id)} disabled={busy === "load"} className="btn-outline !px-3 !py-1 text-xs">Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-xs text-ink-400">
          Tip: open an order in the Orders tab and press Create invoice - the customer, plan and price are filled in for you.
        </p>
      </div>
    );
  }

  const items = draft.items || [];
  const customer = draft.customer || {};
  const localSubtotal = items.reduce((sum, it) => sum + Number(it.qty || 0) * Number(it.rate || 0), 0);
  const localTotal = localSubtotal - Number(draft.discount || 0) + Number(draft.serviceCharge || 0);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button onClick={save} disabled={busy === "save"} className="btn-primary !px-3 !py-1.5 text-xs">
          {busy === "save" ? "Saving..." : "Save"}
        </button>
        <button onClick={print} className="btn-outline !px-3 !py-1.5 text-xs">Print / PDF</button>
        <button onClick={send} disabled={busy === "send"} className="btn-outline !px-3 !py-1.5 text-xs">
          {busy === "send" ? "Sending..." : "Email to customer"}
        </button>
        <button onClick={() => setStatus("paid")} disabled={busy === "status"} className="btn-outline !px-3 !py-1.5 text-xs">Mark paid</button>
        <button onClick={() => setStatus("cancelled")} disabled={busy === "status"} className="btn-outline !px-3 !py-1.5 text-xs">Cancel invoice</button>
        <button onClick={remove} disabled={busy === "delete"} className="btn-ghost !px-3 !py-1.5 text-xs text-red-600">Delete</button>
        <button onClick={() => setDraft(null)} className="btn-ghost ml-auto !px-3 !py-1.5 text-xs">Back to list</button>
      </div>

      {error && <p className="mb-4 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}
      {notice && <p className="mb-4 rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}

      <div className={showPreview ? "grid gap-5 xl:grid-cols-2" : ""}>
        <div className="space-y-4">
          <section className="quiet-card p-4">
            <h3 className="mb-3 text-sm font-semibold text-ink-900">Invoice details</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Invoice number" value={draft.invoiceNo} onChange={(v) => up({ invoiceNo: v })} />
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-ink-600">Status</span>
                <select className="input-base !py-1.5 text-[13px]" value={draft.status || "draft"} onChange={(e) => up({ status: e.target.value })}>
                  {INVOICE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <Field label="Copy status" value={draft.copyStatus} onChange={(v) => up({ copyStatus: v })} placeholder="Original" />
              <Field label="Transaction date" type="date" value={draft.transactionDate} onChange={(v) => up({ transactionDate: v })} />
              <Field label="Issue date" type="date" value={draft.issueDate} onChange={(v) => up({ issueDate: v })} />
              <Field label="Reprint date" type="date" value={draft.reprintDate} onChange={(v) => up({ reprintDate: v })} />
              <Field label="Due date" type="date" value={draft.dueDate} onChange={(v) => up({ dueDate: v })} />
            </div>
          </section>

          <section className="quiet-card p-4">
            <h3 className="mb-3 text-sm font-semibold text-ink-900">Customer</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" value={customer.name} onChange={(v) => upCustomer({ name: v })} />
              <Field label="Customer ID / Username" value={customer.customerId} onChange={(v) => upCustomer({ customerId: v })} />
              <Field label="Business" value={customer.business} onChange={(v) => upCustomer({ business: v })} />
              <Field label="Email" type="email" value={customer.email} onChange={(v) => upCustomer({ email: v })} />
              <Field label="Phone" value={customer.phone} onChange={(v) => upCustomer({ phone: v })} />
              <Field label="Customer TPIN" value={customer.tpin} onChange={(v) => upCustomer({ tpin: v })} />
              <Field label="Customer PAN" value={customer.panNo} onChange={(v) => upCustomer({ panNo: v })} />
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-[11px] font-medium text-ink-600">Billing address</span>
                <textarea rows="2" className="input-base resize-none text-[13px]" value={customer.address || ""} onChange={(e) => upCustomer({ address: e.target.value })} />
              </label>
            </div>
          </section>
          <section className="quiet-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink-900">Items</h3>
              <button onClick={addItem} className="btn-outline !px-3 !py-1 text-xs">Add row</button>
            </div>
            <div className="space-y-3">
              {items.map((it, i) => (
                <div key={i} className="rounded-lg border border-gray-200 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Item {i + 1}</span>
                    <button onClick={() => removeItem(i)} className="text-[11px] text-red-500 hover:underline">Remove</button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Particulars" value={it.particulars} onChange={(v) => upItem(i, { particulars: v })} />
                    <Field label="PAN no" value={it.panNo} onChange={(v) => upItem(i, { panNo: v })} />
                  </div>
                  <label className="mt-2 block">
                    <span className="mb-1 block text-[11px] font-medium text-ink-600">Description</span>
                    <textarea rows="2" className="input-base resize-none text-[13px]" value={it.description || ""} onChange={(e) => upItem(i, { description: e.target.value })} />
                  </label>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Field label="Quantity" type="number" value={it.qty} onChange={(v) => upItem(i, { qty: v })} />
                    <Field label="Rate" type="number" value={it.rate} onChange={(v) => upItem(i, { rate: v })} />
                    <Field label="Package name" value={it.packageName} onChange={(v) => upItem(i, { packageName: v })} />
                    <Field label="Plan" value={it.plan} onChange={(v) => upItem(i, { plan: v })} />
                    <Field label="Billing period" value={it.billingPeriod} onChange={(v) => upItem(i, { billingPeriod: v })} />
                    <Field label="Effective date" type="date" value={it.effectiveDate} onChange={(v) => upItem(i, { effectiveDate: v })} />
                    <div className="col-span-2 flex items-end">
                      <div className="text-[13px] text-ink-500">Amount: <span className="font-semibold text-ink-900">{money(Number(it.qty || 0) * Number(it.rate || 0))}</span></div>
                    </div>
                  </div>
                </div>
              ))}
              {items.length === 0 && <p className="text-xs text-ink-400">No items yet - add a row.</p>}
            </div>
          </section>

          <section className="quiet-card p-4">
            <h3 className="mb-3 text-sm font-semibold text-ink-900">Amounts</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Discount" type="number" value={draft.discount} onChange={(v) => up({ discount: v })} />
              <Field label="Service charge" type="number" value={draft.serviceCharge} onChange={(v) => up({ serviceCharge: v })} />
              <div className="flex items-end">
                <div className="text-[13px] text-ink-500">Total: <span className="font-semibold text-ink-900">{money(localTotal)}</span></div>
              </div>
            </div>
            <label className="mt-3 block">
              <span className="mb-1 block text-[11px] font-medium text-ink-600">Total amount in words</span>
              <input className="input-base !py-1.5 text-[13px]" value={draft.totalInWords || ""} onChange={(e) => up({ totalInWords: e.target.value })} placeholder="Filled automatically from the total" />
            </label>
          </section>

          <section className="quiet-card p-4">
            <h3 className="mb-3 text-sm font-semibold text-ink-900">Payment</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Payment mode" value={draft.paymentMode} onChange={(v) => up({ paymentMode: v })} placeholder="Bank transfer" />
              <Field label="Payment reference" value={draft.paymentRef} onChange={(v) => up({ paymentRef: v })} />
            </div>
          </section>

          <section className="quiet-card p-4">
            <h3 className="mb-3 text-sm font-semibold text-ink-900">Notes and terms</h3>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-ink-600">Notes</span>
              <textarea rows="2" className="input-base resize-none text-[13px]" value={draft.notes || ""} onChange={(e) => up({ notes: e.target.value })} />
            </label>
            <label className="mt-3 block">
              <span className="mb-1 block text-[11px] font-medium text-ink-600">Terms</span>
              <textarea rows="2" className="input-base resize-none text-[13px]" value={draft.terms || ""} onChange={(e) => up({ terms: e.target.value })} />
            </label>
          </section>
        </div>

        {showPreview && (
          <div className="xl:sticky xl:top-20 xl:self-start">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-500">Live preview - exactly what the customer receives</span>
              <button onClick={() => setShowPreview(false)} className="btn-ghost !px-2 !py-1 text-xs">Hide</button>
            </div>
            {previewError && <p className="mb-2 text-xs text-red-500">{previewError}</p>}
            <iframe ref={frameRef} srcDoc={preview} title="Invoice preview" className="h-[760px] w-full rounded-lg border border-gray-200 bg-white" />
          </div>
        )}
      </div>
    </div>
  );
}