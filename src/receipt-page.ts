/**
 * The buyer's receipt page, the one an Insight app serves at /r/<number>
 * (twin of @dontcode/payments' src/server/receipt-page.ts: change them
 * together). Every completed payment's receipt email links to
 * /r/<number>?t=<token> on the app's primary domain; a Backend app mounts
 * `client.payments.handleReceiptRequest` there (Elijah, 2026-11-15).
 *
 * It answers one complete, printable HTML page in the receipt's language: the
 * owner's business and branding, the line items, the amount in its currency,
 * how and when it was paid, a refund, the buyer, a Print / Save as PDF button.
 * Every value in it is text an owner or a buyer typed, so every one is
 * escaped, the logo must be an https URL and the color a hex code; the page
 * carries a nonce-based Content-Security-Policy, is never indexed, never
 * cached and never sends its URL (and so the token) on as a referrer.
 */
import type { ClientReceiptView } from './types'

type Lang = 'en' | 'ko' | 'zh' | 'ja'

const WORDS = {
    en: {
        receipt: 'Receipt',
        subscriptionReceipt: 'Subscription receipt',
        refundReceipt: 'Refund receipt',
        receiptNumber: 'Receipt number',
        paid: 'Paid',
        refunded: 'Refunded',
        refund: 'Refund',
        paidOn: 'Paid on',
        refundedOn: 'Refunded on',
        method: 'Payment method',
        issuedBy: 'Issued by',
        billedTo: 'Billed to',
        registration: 'Business registration',
        representative: 'Representative',
        address: 'Address',
        phone: 'Phone',
        mailOrder: 'Mail-order business',
        email: 'Email',
        item: 'Item',
        qty: 'Qty',
        amount: 'Amount',
        total: 'Total',
        totalRefunded: 'Total refunded',
        print: 'Print or save as PDF',
        poweredBy: 'Powered by DontCode',
        notFoundTitle: 'Receipt not found',
        notFoundBody: 'Check the link in your email, or ask the seller for it again.',
        unavailableTitle: "This receipt can't be shown right now",
        unavailableBody: 'Try again in a few minutes.',
        methods: {
            card: 'Card',
            kakaopay: 'Kakao Pay',
            tosspay: 'Toss Pay',
            naverpay: 'Naver Pay',
            transfer: 'Bank transfer',
            samsungpay: 'Samsung Pay',
            applepay: 'Apple Pay',
            payco: 'PAYCO',
            paypal: 'PayPal',
        } as Record<string, string>,
    },
    ko: {
        receipt: '영수증',
        subscriptionReceipt: '구독 영수증',
        refundReceipt: '환불 영수증',
        receiptNumber: '영수증 번호',
        paid: '결제 완료',
        refunded: '환불됨',
        refund: '환불',
        paidOn: '결제일',
        refundedOn: '환불일',
        method: '결제 수단',
        issuedBy: '발행자',
        billedTo: '구매자',
        registration: '사업자등록번호',
        representative: '대표자',
        address: '주소',
        phone: '전화번호',
        mailOrder: '통신판매업 신고번호',
        email: '이메일',
        item: '항목',
        qty: '수량',
        amount: '금액',
        total: '합계',
        totalRefunded: '환불 합계',
        print: '인쇄 또는 PDF로 저장',
        // The same line the buyer's receipt email ends with.
        poweredBy: '돈코드로 만들었어요',
        notFoundTitle: '영수증을 찾을 수 없습니다',
        notFoundBody: '이메일의 링크를 확인하시거나 판매자에게 다시 요청해 주세요.',
        unavailableTitle: '지금은 영수증을 보여 드릴 수 없습니다',
        unavailableBody: '잠시 후 다시 시도해 주세요.',
        methods: {
            card: '카드',
            kakaopay: 'Kakao Pay',
            tosspay: 'Toss Pay',
            naverpay: 'Naver Pay',
            transfer: '계좌이체',
            samsungpay: '삼성페이',
            applepay: '애플페이',
            payco: '페이코',
            paypal: '페이팔',
        } as Record<string, string>,
    },
    zh: {
        receipt: '收据',
        subscriptionReceipt: '订阅收据',
        refundReceipt: '退款收据',
        receiptNumber: '收据编号',
        paid: '已支付',
        refunded: '已退款',
        refund: '退款',
        paidOn: '支付时间',
        refundedOn: '退款时间',
        method: '支付方式',
        issuedBy: '商家',
        billedTo: '买家',
        registration: '营业登记号',
        representative: '代表人',
        address: '地址',
        phone: '电话',
        mailOrder: '通信销售业申报号',
        email: '邮箱地址',
        item: '项目',
        qty: '数量',
        amount: '金额',
        total: '合计',
        totalRefunded: '退款合计',
        print: '打印或保存为 PDF',
        poweredBy: '使用 DontCode 制作',
        notFoundTitle: '找不到收据',
        notFoundBody: '请检查邮件中的链接，或请卖家重新发送。',
        unavailableTitle: '暂时无法显示此收据',
        unavailableBody: '请几分钟后重试。',
        methods: {
            card: '银行卡',
            kakaopay: 'Kakao Pay',
            tosspay: 'Toss Pay',
            naverpay: 'Naver Pay',
            transfer: '银行转账',
            samsungpay: 'Samsung Pay',
            applepay: 'Apple Pay',
            payco: 'PAYCO',
            paypal: 'PayPal',
        } as Record<string, string>,
    },
    ja: {
        receipt: '領収書',
        subscriptionReceipt: 'サブスクリプションの領収書',
        refundReceipt: '返金の領収書',
        receiptNumber: '領収書番号',
        paid: '支払い済み',
        refunded: '返金済み',
        refund: '返金',
        paidOn: 'お支払い日時',
        refundedOn: '返金日時',
        method: 'お支払い方法',
        issuedBy: '発行者',
        billedTo: '購入者',
        registration: '事業者登録番号',
        representative: '代表者',
        address: '住所',
        phone: '電話番号',
        mailOrder: '通信販売業届出番号',
        email: 'メールアドレス',
        item: '品目',
        qty: '数量',
        amount: '金額',
        total: '合計',
        totalRefunded: '返金合計',
        print: '印刷またはPDFで保存',
        poweredBy: 'DontCode で作成',
        notFoundTitle: '領収書が見つかりません',
        notFoundBody: 'メールのリンクをご確認いただくか、販売者にもう一度お問い合わせください。',
        unavailableTitle: '現在、この領収書を表示できません',
        unavailableBody: '数分後にもう一度お試しください。',
        methods: {
            card: 'カード',
            kakaopay: 'Kakao Pay',
            tosspay: 'Toss Pay',
            naverpay: 'Naver Pay',
            transfer: '銀行振込',
            samsungpay: 'Samsung Pay',
            applepay: 'Apple Pay',
            payco: 'PAYCO',
            paypal: 'PayPal',
        } as Record<string, string>,
    },
} satisfies Record<Lang, unknown>

/** The page's `lang` attribute: Chinese is Simplified, so browsers draw its glyphs. */
const HTML_LANG: Record<Lang, string> = { en: 'en', ko: 'ko', zh: 'zh-Hans', ja: 'ja' }

/** The Intl locale each language formats numbers and dates in. */
const INTL_LOCALE: Record<Lang, string> = { en: 'en-US', ko: 'ko-KR', zh: 'zh-CN', ja: 'ja-JP' }

function normalizeCurrency(currency: string | null | undefined): string {
    const code = typeof currency === 'string' ? currency.trim().toUpperCase() : ''
    return code || 'KRW'
}

function minorUnitDigits(currency: string): number {
    try {
        return (
            new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: normalizeCurrency(currency),
            }).resolvedOptions().maximumFractionDigits ?? 2
        )
    } catch {
        return 2
    }
}

/** `minor` (the smallest unit) as each language writes it (twin of @dontcode/payments' lib/money.ts). */
function formatMoney(minor: number, currency: string | null | undefined, lang: Lang): string {
    const code = normalizeCurrency(currency)
    if (code === 'KRW' && (lang === 'ko' || lang === 'en')) {
        return lang === 'ko'
            ? `${minor.toLocaleString('ko-KR')}원`
            : `₩${minor.toLocaleString('en-US')}`
    }
    const digits = minorUnitDigits(code)
    const major = minor / 10 ** digits
    try {
        return new Intl.NumberFormat(INTL_LOCALE[lang] ?? 'en-US', {
            style: 'currency',
            currency: code,
        }).format(major)
    } catch {
        return `${major.toFixed(digits)} ${code}`
    }
}

/** Every interpolated value goes through here: it is merchant- and buyer-supplied text. */
export function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

/** A logo the page may load: an https URL, nothing else (no javascript:, data: or plain http). */
function safeLogoUrl(value: string | null): string | null {
    if (!value) return null
    try {
        const url = new URL(value)
        return url.protocol === 'https:' ? url.toString() : null
    } catch {
        return null
    }
}

const DEFAULT_COLOR = '#111827'

/** The brand color goes into CSS: a hex code or the default, never anything else. */
function safeColor(value: string | null): string {
    return value && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : DEFAULT_COLOR
}

/** A language tag by its primary subtag ('zh-TW' and 'zh-Hans' are zh), when the receipt has words in it. */
function langOf(value: unknown): Lang | null {
    if (typeof value !== 'string') return null
    const primary = value.trim().toLowerCase().split(/[-_]/)[0]
    return (Object.keys(HTML_LANG) as Lang[]).find((lang) => lang === primary) ?? null
}

/** For a page with no receipt to read a language from: the buyer's browser, else English. */
function requestLang(request: Request): Lang {
    const accepted = request.headers.get('accept-language') ?? ''
    for (const part of accepted.split(',')) {
        const lang = langOf(part.split(';')[0])
        if (lang) return lang
    }
    return 'en'
}

/** A date in Korean time, where the platform bills, written the receipt's way. */
function formatDate(iso: string, lang: Lang): string {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return iso
    return new Intl.DateTimeFormat(INTL_LOCALE[lang], {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'Asia/Seoul',
        timeZoneName: 'short',
    }).format(date)
}

/** The answer looks like a receipt: anything else is the service misbehaving, not a receipt. */
function isReceiptView(value: unknown): value is ClientReceiptView {
    if (!value || typeof value !== 'object') return false
    const v = value as Record<string, unknown>
    const issuer = v.issuer as Record<string, unknown> | null
    return (
        typeof v.number === 'string' &&
        typeof v.amount === 'number' &&
        typeof v.currency === 'string' &&
        typeof v.paidAt === 'string' &&
        Array.isArray(v.lineItems) &&
        !!issuer &&
        typeof issuer === 'object' &&
        typeof issuer.appName === 'string' &&
        !!v.customer &&
        typeof v.customer === 'object'
    )
}

const STYLE = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#F3F4F6;color:#111827;font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}
.sheet{max-width:640px;margin:32px auto;background:#fff;border:1px solid #E5E7EB;border-radius:12px;overflow:hidden}
.bar{height:4px;background:var(--brand)}
.body{padding:28px}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.brand img{max-height:40px;max-width:120px;object-fit:contain}
.app{font-weight:600;font-size:16px;overflow-wrap:anywhere}
.badge{flex-shrink:0;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;background:#ECFDF5;color:#065F46}
.badge.off{background:#F3F4F6;color:#374151}
h1{margin:24px 0 4px;font-size:22px;font-weight:600;letter-spacing:-0.01em}
.total{margin:0;font-size:28px;font-weight:600;letter-spacing:-0.02em}
dl{margin:20px 0 0;display:grid;grid-template-columns:max-content 1fr;gap:6px 16px}
dt{color:#6B7280}
dd{margin:0;overflow-wrap:anywhere}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:28px;padding-top:20px;border-top:1px solid #F3F4F6}
.parties h2{margin:0 0 6px;font-size:12px;font-weight:600;color:#6B7280}
.parties p{margin:0;overflow-wrap:anywhere}
.parties .muted{color:#4B5563}
table{width:100%;border-collapse:collapse;margin-top:28px}
th{text-align:left;font-size:12px;font-weight:600;color:#6B7280;padding:0 0 8px;border-bottom:1px solid #E5E7EB}
td{padding:10px 0;border-bottom:1px solid #F3F4F6;vertical-align:top;overflow-wrap:anywhere}
.num{text-align:right;white-space:nowrap;padding-left:12px}
tfoot td{border-bottom:none;font-weight:600;padding-top:14px}
.note{margin:24px 0 0;color:#4B5563;white-space:pre-line;overflow-wrap:anywhere}
.actions{margin-top:28px}
button{font:inherit;font-weight:600;color:#fff;background:var(--brand);border:none;border-radius:8px;padding:10px 16px;cursor:pointer}
.powered{max-width:640px;margin:0 auto 32px;text-align:center;font-size:12px;color:#9CA3AF}
.powered a{color:inherit}
.empty{text-align:center}
.empty p{color:#4B5563}
@media (max-width:520px){.sheet{margin:0;border-radius:0;border-left:none;border-right:none}.body{padding:20px 16px}.parties{grid-template-columns:1fr}}
@media print{body{background:#fff}.sheet{margin:0;border:none;max-width:none}.bar,.badge,button{-webkit-print-color-adjust:exact;print-color-adjust:exact}.actions{display:none}.powered{margin-bottom:0}}
`

function page(params: {
    lang: Lang
    title: string
    color: string
    nonce: string
    body: string
    script?: string
}): string {
    const { lang, nonce } = params
    return `<!doctype html>
<html lang="${HTML_LANG[lang]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(params.title)}</title>
<style nonce="${nonce}">:root{--brand:${params.color}}${STYLE}</style>
</head>
<body>
${params.body}
<p class="powered"><a href="https://www.dontcode.co${lang === 'ko' ? '/ko' : ''}" rel="noopener">${escapeHtml(WORDS[lang].poweredBy)}</a></p>
${params.script ? `<script nonce="${nonce}">${params.script}</script>` : ''}
</body>
</html>`
}

/** The receipt as HTML, every value escaped. */
export function renderReceiptPage(view: ClientReceiptView, nonce: string): string {
    const lang: Lang = langOf(view.locale) ?? 'en'
    const w = WORDS[lang]
    const money = (minor: number) => formatMoney(minor, view.currency, lang)
    const { issuer, customer } = view
    const title =
        view.kind === 'refund'
            ? w.refundReceipt
            : view.kind === 'subscription'
              ? w.subscriptionReceipt
              : w.receipt
    const refunded = view.kind !== 'refund' && view.status === 'refunded'
    const badge =
        view.kind === 'refund'
            ? `<span class="badge off">${escapeHtml(w.refund)}</span>`
            : refunded
              ? `<span class="badge off">${escapeHtml(w.refunded)}</span>`
              : `<span class="badge">${escapeHtml(w.paid)}</span>`
    const logo = safeLogoUrl(issuer.logoUrl)

    const methodLabel = view.paymentMethod
        ? (w.methods[view.paymentMethod] ?? view.paymentMethod)
        : null
    const method = [methodLabel, view.paymentDetail].filter(Boolean).join(' · ')

    const meta: Array<[string, string]> = [
        [w.receiptNumber, view.number],
        [view.kind === 'refund' ? w.refundedOn : w.paidOn, formatDate(view.paidAt, lang)],
    ]
    if (method) meta.push([w.method, method])
    if (refunded && view.refundedAt) meta.push([w.refundedOn, formatDate(view.refundedAt, lang)])

    const issuerLines: string[] = [`<p>${escapeHtml(issuer.businessName || issuer.appName)}</p>`]
    const issuerFacts: Array<[string, string | null]> = [
        [w.representative, issuer.representative],
        [w.registration, issuer.registrationNumber],
        [w.mailOrder, issuer.mailOrderNumber],
        [w.address, issuer.address],
        [w.phone, issuer.phone],
        [w.email, issuer.email],
    ]
    for (const [label, value] of issuerFacts) {
        if (value) {
            issuerLines.push(`<p class="muted">${escapeHtml(label)}: ${escapeHtml(value)}</p>`)
        }
    }
    const buyerLines = [customer.name, customer.email]
        .filter((v): v is string => !!v)
        .map((v, i) => `<p${i > 0 || !customer.name ? ' class="muted"' : ''}>${escapeHtml(v)}</p>`)

    const rows = view.lineItems
        .map(
            (item) =>
                `<tr><td>${escapeHtml(item.name)}</td><td class="num">${escapeHtml(item.quantity)}</td><td class="num">${escapeHtml(money(item.amount))}</td></tr>`
        )
        .join('')

    const body = `<main class="sheet">
<div class="bar"></div>
<div class="body">
<div class="head">
<div class="brand">${logo ? `<img src="${escapeHtml(logo)}" alt="">` : ''}<span class="app">${escapeHtml(issuer.appName)}</span></div>
${badge}
</div>
<h1>${escapeHtml(title)}</h1>
<p class="total">${escapeHtml(money(view.amount))}</p>
<dl>${meta.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>
<div class="parties">
<section><h2>${escapeHtml(w.issuedBy)}</h2>${issuerLines.join('')}</section>
${buyerLines.length ? `<section><h2>${escapeHtml(w.billedTo)}</h2>${buyerLines.join('')}</section>` : ''}
</div>
<table>
<thead><tr><th>${escapeHtml(w.item)}</th><th class="num">${escapeHtml(w.qty)}</th><th class="num">${escapeHtml(w.amount)}</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td colspan="2">${escapeHtml(view.kind === 'refund' ? w.totalRefunded : w.total)}</td><td class="num">${escapeHtml(money(view.amount))}</td></tr></tfoot>
</table>
${issuer.footer ? `<p class="note">${escapeHtml(issuer.footer)}</p>` : ''}
<div class="actions"><button type="button" id="print">${escapeHtml(w.print)}</button></div>
</div>
</main>`

    return page({
        lang,
        title: `${title} ${view.number}`,
        color: safeColor(issuer.color),
        nonce,
        body,
        script: `document.getElementById('print').addEventListener('click',function(){window.print()})`,
    })
}

function messagePage(lang: Lang, nonce: string, heading: string, line: string): string {
    return page({
        lang,
        title: heading,
        color: DEFAULT_COLOR,
        nonce,
        body: `<main class="sheet"><div class="bar"></div><div class="body empty"><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(line)}</p></div></main>`,
    })
}

function htmlResponse(html: string, status: number, nonce: string): Response {
    return new Response(html, {
        status,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': [
                "default-src 'none'",
                `style-src 'nonce-${nonce}'`,
                `script-src 'nonce-${nonce}'`,
                'img-src https:',
                "base-uri 'none'",
                "form-action 'none'",
                "frame-ancestors 'none'",
            ].join('; '),
            'X-Robots-Tag': 'noindex, nofollow, noarchive',
            'Referrer-Policy': 'no-referrer',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
        },
    })
}

/** A fresh nonce for the page's one style and one script, from the platform's crypto. */
export function receiptNonce(): string {
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
}

/** A receipt number and its token as the platform writes them, or close: never a path. */
export const RECEIPT_NUMBER_PATTERN = /^[0-9A-Za-z-]{1,40}$/
export const RECEIPT_TOKEN_PATTERN = /^[0-9A-Za-z_-]{1,200}$/

export type ReceiptLang = Lang
export { isReceiptView, requestLang, htmlResponse, messagePage, WORDS as RECEIPT_WORDS }
