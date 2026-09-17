import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/supabaseClient";

const STATUSES = ["received", "pending", "completed", "cancelled"];
const STATUS_STYLE = {
  received: "border-blue-100 bg-blue-50 text-blue-700",
  pending: "border-amber-100 bg-amber-50 text-amber-700",
  completed: "border-emerald-100 bg-emerald-50 text-emerald-700",
  cancelled: "border-gray-200 bg-gray-100 text-gray-600",
};
const PLAN_PRICE = { pro: 1500, agency: 4500 };
const PLAN_LABEL = { pro: "Pro", agency: "Agency" };
const npr = (n) => "Rs. " + Number(n || 0).toLocaleString("en-IN");

/**
 * Orders tab. Upgrade requests raised from the billing page: label them,
 * correct any detail, activate the plan once payment clears, and raise an
 * invoice for the customer.
 */
export default function AdminOrders({ onInvoiced }) {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState("");
  const [form, setForm] = useState({});

  const load = useCallback(async () => {
    try {
      const d = await api("/api/admin/orders");
      setOrders(d.orders || []);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openEdit(o) {
    setEditing(o.id);
    setError("");
    setNotice("");
    setForm({
      name: o.name || "",
      email: o.email || "",
      phone: o.phone || "",
      plan: o.plan || "pro",
      amountNpr: o.amountNpr || PLAN_PRICE[o.plan] || 1500,
      status: o.status || "received",
      message: o.message || "",
      adminNotes: o.adminNotes || "",
    });
  }

  async function patch(id, body, okMessage) {
    setBusy(String(id));
    setError("");
    setNotice("");
    try {
      await api("/api/admin/orders/" + id, { method: "PATCH", body: JSON.stringify(body) });
      if (okMessage) setNotice(okMessage);
      await load();
    } catch (e) {
      setError(e.message);
    }
    setBusy("");
  }

  async function activate(o) {
    if (!confirm("Activate the " + PLAN_LABEL[o.plan] + " plan for " + (o.business || o.email) + " for 30 days?")) return;
    setBusy(String(o.id));
    setError("");
    setNotice("");
    try {
      await api("/api/admin/orders/" + o.id + "/activate", { method: "POST", body: "{}" });
      setNotice(PLAN_LABEL[o.plan] + " activated for " + (o.business || o.email) + " for 30 days.");
      await load();
    } catch (e) {
      setError(e.message);
    }
    setBusy("");
  }

  async function raiseInvoice(o) {
    setBusy(String(o.id));
    setError("");
    setNotice("");
    try {
      const d = await api("/api/admin/invoices", {
        method: "POST",
        body: JSON.stringify({ planRequestId: o.id }),
      });
      setNotice("Invoice " + d.invoice.invoiceNo + " created - opening the editor.");
      if (onInvoiced) onInvoiced(d.invoice.id);
      await load();
    } catch (e) {
      setError(e.message);
    }
    setBusy("");
  }

  const list = (orders || []).filter((o) => filter === "all" || o.status === filter);
  const counts = STATUSES.reduce((acc, s) => {
    acc[s] = (orders || []).filter((o) => o.status === s).length;
    return acc;
  }, {});

  if (!orders) return <p className="py-10 text-sm text-ink-400">Loading orders...</p>;

  return (
    <div>
      {error && <p className="mb-4 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}
      {notice && <p className="mb-4 rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {["all", ...STATUSES].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={(filter === s ? "btn-primary" : "btn-outline") + " !px-3 !py-1.5 text-xs capitalize"}
          >
            {s === "all" ? "All (" + orders.length + ")" : s + " (" + (counts[s] || 0) + ")"}
          </button>
        ))}
      </div>

      <div className="quiet-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-ink-400">
              <th className="px-4 py-3 font-medium">Order</th>
              <th className="px-4 py-3 font-medium">Customer</th>
              <th className="px-4 py-3 font-medium">Plan</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Invoice</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-ink-400">No orders here yet.</td></tr>
            )}
            {list.map((o) => (
              <tr key={o.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-900/[0.015]">
                <td className="px-4 py-3.5 align-top">
                  <div className="font-medium text-ink-900">{o.orderId}</div>
                  <div className="text-xs text-ink-400">{String(o.createdAt || "").slice(0, 10)}</div>
                </td>
                <td className="px-4 py-3.5 align-top">
                  <div className="text-ink-900">{o.name || "-"}</div>
                  <div className="text-xs text-ink-400">{o.email}</div>
                  <div className="text-xs text-ink-400">{o.phone}</div>
                  {o.business && <div className="mt-1 text-xs font-medium text-ink-500">{o.business}</div>}
                </td>
                <td className="px-4 py-3.5 align-top">
                  <div className="text-ink-900">{PLAN_LABEL[o.plan] || o.plan}</div>
                  <div className="text-xs text-ink-400">{npr(o.amountNpr || PLAN_PRICE[o.plan])}</div>
                </td>
                <td className="px-4 py-3.5 align-top">
                  <span className={"inline-block rounded-full border px-2.5 py-0.5 text-[11px] font-medium capitalize " + (STATUS_STYLE[o.status] || STATUS_STYLE.received)}>
                    {o.status}
                  </span>
                  <select
                    value={o.status}
                    disabled={busy === String(o.id)}
                    onChange={(e) => patch(o.id, { status: e.target.value }, "Order " + o.orderId + " marked " + e.target.value + ".")}
                    className="input-base mt-2 !px-2 !py-1 text-xs"
                  >
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
                <td className="px-4 py-3.5 align-top text-xs">
                  {(o.invoices || []).length === 0 && <span className="text-ink-400">none</span>}
                  {(o.invoices || []).map((inv) => (
                    <div key={inv.id} className="text-ink-700">
                      {inv.invoice_no}
                      <span className="ml-1 text-ink-400">({inv.status})</span>
                    </div>
                  ))}
                </td>
                <td className="px-4 py-3.5 align-top text-right">
                  <div className="flex flex-col items-end gap-1.5">
                    <button onClick={() => openEdit(o)} className="btn-outline !px-3 !py-1 text-xs">Edit</button>
                    <button
                      onClick={() => raiseInvoice(o)}
                      disabled={busy === String(o.id)}
                      className="btn-outline !px-3 !py-1 text-xs"
                    >
                      Create invoice
                    </button>
                    {o.status !== "completed" && (
                      <button
                        onClick={() => activate(o)}
                        disabled={busy === String(o.id)}
                        className="btn-primary !px-3 !py-1 text-xs"
                      >
                        Activate plan
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-ink-400">
        Mark an order completed once the payment clears, then Activate plan to switch the business over for 30 days.
      </p>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-ink-900/40 backdrop-blur-sm" onClick={() => setEditing(null)} />
          <div className="relative w-full max-w-lg rounded-xl border border-gray-200 bg-white p-5 shadow-2xl sm:p-6">
            <button
              onClick={() => setEditing(null)}
              aria-label="Close"
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-ink-400 hover:bg-gray-100 hover:text-ink-700"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
            <h3 className="h-display text-lg">Edit order</h3>
            <p className="mt-1 text-xs text-ink-500">Correct anything the customer typed before you invoice them.</p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-600">Name</span>
                <input className="input-base" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-600">Email</span>
                <input className="input-base" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-600">Phone</span>
                <input className="input-base" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-600">Plan</span>
                <select
                  className="input-base"
                  value={form.plan}
                  onChange={(e) => setForm({ ...form, plan: e.target.value, amountNpr: PLAN_PRICE[e.target.value] || form.amountNpr })}
                >
                  <option value="pro">Pro</option>
                  <option value="agency">Agency</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-600">Amount (NPR)</span>
                <input className="input-base" type="number" min="0" value={form.amountNpr} onChange={(e) => setForm({ ...form, amountNpr: e.target.value })} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-600">Status</span>
                <select className="input-base" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs font-medium text-ink-600">Customer message</span>
                <textarea rows="2" className="input-base resize-none" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs font-medium text-ink-600">Internal notes</span>
                <textarea rows="2" className="input-base resize-none" value={form.adminNotes} onChange={(e) => setForm({ ...form, adminNotes: e.target.value })} placeholder="Only your team sees this" />
              </label>
            </div>

            <div className="mt-5 flex gap-2">
              <button onClick={() => setEditing(null)} className="btn-secondary flex-1">Cancel</button>
              <button
                onClick={async () => { await patch(editing, form, "Order updated."); setEditing(null); }}
                disabled={busy === String(editing)}
                className="btn-primary flex-1"
              >
                {busy === String(editing) ? "Saving..." : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}