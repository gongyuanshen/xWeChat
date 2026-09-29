// Media quota formatting and the existing backend-compatible redemption normalization.
export const MiB = 1048576
export const GiB = MiB * 1024
export const TiB = GiB * 1024

export function fmtBytes(b) {
  if (b == null || !Number.isFinite(Number(b))) return { num: '—', unit: '' }
  b = Number(b)
  if (b < 1) return { num: '0', unit: 'B' }
  if (b < GiB) return { num: (b / MiB).toFixed(1), unit: 'MiB' }
  if (b < TiB) return { num: (b / GiB).toFixed(2), unit: 'GiB' }
  return { num: (b / TiB).toFixed(2), unit: 'TiB' }
}
export const fmtB = (b) => { const f = fmtBytes(b); return `${f.num} ${f.unit}`.trim() }
export function normalizeRedeemCode(raw) {
  let s = String(raw || '').replace(/[\s\-‐‑–—－_]/g, '').toUpperCase()
  if (s.startsWith('WX')) s = s.slice(2)
  const out = [], fixes = []
  for (const ch of s) {
    let c = ch
    if (c === 'O') { c = '0'; fixes.push(out.length) } else if (c === 'I' || c === 'L') { c = '1'; fixes.push(out.length) }
    if (/[0-9A-HJKMNP-TV-Z]/.test(c) && out.length < 20) out.push(c)
  }
  return { code: out.join(''), fixes }
}
