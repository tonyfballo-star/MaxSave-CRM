// Patch 5: paginate the Customers list (50 per page) and wire its Call/Text buttons. Idempotent.
// Run from the MSICRM folder: node supabase/patch-5-customers-paging.js
const fs = require('fs'); const path = require('path');
const FILE = path.join(__dirname, '..', 'maxsave_crm.html');
let src = fs.readFileSync(FILE, 'utf8');
const CRLF = src.includes('\r\n'); if (CRLF) src = src.replace(/\r\n/g, '\n');
if (src.includes('window._customerPages')) { console.log('Already patched — nothing to do.'); process.exit(0); }
const log = [];
function once(anchor, replacement, label) { const n = src.split(anchor).length - 1; if (n !== 1) throw new Error(`[${label}] expected 1 match, found ${n}`); src = src.replace(anchor, () => replacement); log.push(label); }

// 1. Slice the filtered list to the current page (state: page, perPage) and reset to page 1 when any filter changes
once("  ${(()=>{ window._currentCustomerList = list; return ''; })()}",
"  ${(()=>{ const s = window.CUSTOMERS_STATE; s.perPage = s.perPage || 50; const key = [s.tab,s.carrier,s.city,s.zip,s.ageMin,s.ageMax,s.search,s.payPeriodOnly,s.openBalanceOnly,s.brokerFeeCollectedOnly,s.renewalWindow].join('|'); if (s._filterKey !== key) { s._filterKey = key; s.page = 1; } s.page = s.page || 1; const totalPages = Math.max(1, Math.ceil(list.length / s.perPage)); if (s.page > totalPages) s.page = totalPages; const start = (s.page - 1) * s.perPage; window._customerPages = { total: list.length, totalPages, page: s.page, start, end: Math.min(start + s.perPage, list.length) }; list = list.slice(start, start + s.perPage); window._currentCustomerList = list; return ''; })()}", 'customers page slice');

// 2. Pager under the customers table (anchor on the table that follows the customer View button)
{
  const viewBtn = "onclick=\"openCustomerDetail('${c.id}')\"";
  const i = src.indexOf(viewBtn); if (i < 0) throw new Error('customer view button not found');
  const tail = "      </tbody>\n    </table>\n  </div>\n  `;\n}";
  const j = src.indexOf(tail, i); if (j < 0 || j - i > 4000) throw new Error('customers table tail not found near view button');
  const pager = "      </tbody>\n    </table>\n    ${(()=>{ const pg = window._customerPages; if (!pg || pg.total <= 50) return ''; const btn = (label, disabled, p) => `<button class=\"btn btn-ghost\" style=\"font-size:13px;padding:7px 13px${disabled?';opacity:0.4;cursor:not-allowed':''}\" ${disabled?'disabled':''} onclick=\"window.CUSTOMERS_STATE.page=${p};refreshCustomers()\">${label}</button>`; return `<div style=\"padding:14px 18px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--border);background:var(--gray-50)\"><div style=\"font-size:13.5px;color:var(--gray-600)\">Showing ${pg.start+1}–${pg.end} of <strong>${pg.total}</strong> customers · 50 per page</div><div style=\"display:flex;gap:6px;align-items:center\">${btn('← Prev', pg.page<=1, pg.page-1)}<span style=\"font-size:13px;color:var(--gray-600);padding:0 6px\">Page ${pg.page} of ${pg.totalPages}</span>${btn('Next →', pg.page>=pg.totalPages, pg.page+1)}</div></div>`; })()}\n  </div>\n  `;\n}";
  src = src.slice(0, j) + pager + src.slice(j + tail.length); log.push('customers pager');
}

// 3. Real Call / Text buttons on customer rows (scoped to the customers table)
{
  const start = src.indexOf('function renderCustomersPage'); const end = src.indexOf('\n}\n', start);
  let seg = src.slice(start, end);
  const a = "onclick=\"alert('Calling ${c.first}…')\""; const b = "title=\"Text\" onclick=\"openTextThread()\"";
  if (seg.split(a).length - 1 !== 1 || seg.split(b).length - 1 !== 1) throw new Error('customer call/text buttons not found exactly once');
  seg = seg.replace(a, "onclick=\"customerCall('${c.id}')\"").replace(b, "title=\"Text\" onclick=\"customerText('${c.id}')\"");
  src = src.slice(0, start) + seg + src.slice(end); log.push('customer call/text buttons');
}

fs.writeFileSync(FILE, CRLF ? src.replace(/\n/g, '\r\n') : src, 'utf8');
console.log('Applied ' + log.length + ' edits:\n - ' + log.join('\n - '));
