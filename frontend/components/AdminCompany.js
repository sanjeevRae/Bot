import { useState, useEffect } from "react";
import { api } from "../lib/supabaseClient";

const FIELDS = [
  ["name", "Company name", "text"],
  ["email", "Email", "email"],
  ["phone", "Phone", "text"],
  ["website", "Website", "text"],
  ["regNo", "Company registration no.", "text"],
  ["tpin", "Company TPIN", "text"],
  ["panNo", "Company PAN no.", "text"],
  ["logoUrl", "Logo URL", "text"],
  ["paymentQrUrl", "Payment QR image URL", "text"],
  ["signatureUrl", "Signature image URL", "text"],
  ["stampUrl", "Stamp image URL", "text"],
];

/**
 * Company tab: the issuer details printed at the top of every invoice.
 */
export default function AdminCompany() {
  const [company, setCompany] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api("/api/admin/billing-profile")
      .then((d) => setCompany(d.company || {}))
      .catch((e) => setError(e.message));
  }, []);

  const up = (patch) => setCompany((c) => ({ ...c, ...patch }));

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const d = await api("/api/admin/billing-profile", {
        method: "PATCH",
        body: JSON.stringify(company),
      });
      setCompany(d.company || {});
      setNotice("Saved. New invoices will use these details.");
    } catch (e) {
      setError(e.message);
    }
    setSaving(false);
  }

  if (!company) return <p className="py-10 text-sm text-ink-400">Loading company details...</p>;

  return (
    <div className="max-w-3xl">
      {error && <p className="mb-4 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}
      {notice && <p className="mb-4 rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}

      <section className="quiet-card p-5">
        <h3 className="text-sm font-semibold text-ink-900">Invoice header</h3>
        <p className="mt-1 text-xs text-ink-400">
          These details appear at the top of every invoice, alongside the logo and registration/TPIN numbers.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {FIELDS.map(([key, label, type]) => (
            <label key={key} className={key === "name" || key === "email" ? "block" : "block"}>
              <span className="mb-1 block text-xs font-medium text-ink-600">{label}</span>
              <input
                className="input-base !py-2 text-[13px]"
                type={type}
                value={company[key] || ""}
                onChange={(e) => up({ [key]: e.target.value })}
              />
            </label>
          ))}
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-ink-600">Address</span>
            <textarea rows="2" className="input-base resize-none text-[13px]" value={company.address || ""} onChange={(e) => up({ address: e.target.value })} />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-ink-600">Bank details</span>
            <textarea rows="2" className="input-base resize-none text-[13px]" value={company.bankDetails || ""} onChange={(e) => up({ bankDetails: e.target.value })} placeholder="Bank name, account name, account number" />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-ink-600">Payment instructions</span>
            <textarea rows="2" className="input-base resize-none text-[13px]" value={company.paymentInstructions || ""} onChange={(e) => up({ paymentInstructions: e.target.value })} />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-ink-600">Footer note</span>
            <input className="input-base !py-2 text-[13px]" value={company.footerNote || ""} onChange={(e) => up({ footerNote: e.target.value })} placeholder="This is a computer-generated invoice..." />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-ink-600">Thank-you message</span>
            <input className="input-base !py-2 text-[13px]" value={company.thankYou || ""} onChange={(e) => up({ thankYou: e.target.value })} placeholder="Thank you for your business!" />
          </label>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <button onClick={save} disabled={saving} className="btn-primary">
            {saving ? "Saving..." : "Save company details"}
          </button>
          <a href={`/logo.png`} target="_blank" rel="noreferrer" className="btn-link text-xs">View current logo</a>
        </div>
      </section>

      <p className="mt-4 text-xs text-ink-400">
        Tip: to use the Chitra AI logo on invoices, set the Logo URL to your deployed backend URL followed by /logo.png.
      </p>
    </div>
  );
}