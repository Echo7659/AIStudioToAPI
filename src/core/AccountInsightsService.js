/* global document */
const crypto = require("crypto");

const BILLING_URL = "https://aistudio.google.com/billing";
const QUOTA_URL = "https://aistudio.google.com/rate-limit";
const CREDITS_URL = "https://console.cloud.google.com/billing/credits";
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

const clone = value => JSON.parse(JSON.stringify(value));
const normalized = value =>
    String(value || "")
        .replace(/\s+/g, " ")
        .trim();

function money(value) {
    const displayValue = normalized(value);
    const match = displayValue.match(
        /^(?:(USD|EUR|GBP|CAD|AUD|JPY|CNY)\s*|([A-Z]{0,2}\$|€|£|¥)\s*)(-?\d[\d,]*(?:\.\d+)?)(?:\s*(USD|EUR|GBP|CAD|AUD|JPY|CNY))?$/
    );
    if (!match) return null;
    const amount = Number(match[3].replace(/,/g, ""));
    if (!Number.isFinite(amount)) return null;
    const currencies = { A$: "AUD", CA$: "CAD", US$: "USD", "£": "GBP", "€": "EUR" };
    return { amount, currency: match[1] || match[4] || currencies[match[2]] || null, displayValue };
}

function quantity(value) {
    const match = normalized(value)
        .replace(/,/g, "")
        .match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
    if (!match) return null;
    const number = Number(match[1]) * ({ B: 1e9, K: 1e3, M: 1e6 }[match[2]?.toUpperCase()] || 1);
    return Number.isFinite(number) ? number : null;
}

function date(value) {
    const match = normalized(value).match(
        /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})$/
    );
    if (!match) return null;
    const month =
        [
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December",
        ].indexOf(match[1]) + 1;
    return `${match[3]}-${String(month).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function emptySnapshot(checkedAt, reason) {
    return {
        balance: {
            billingAccountId: null,
            billingStatus: null,
            currency: null,
            eligibleGcpCredits: [],
            prepaid: null,
            promotionalCredits: [],
            reason,
            scope: "official_gemini_api",
            source: BILLING_URL,
            status: "unavailable",
        },
        checkedAt,
        quota: {
            limits: [],
            projectId: null,
            reason,
            scope: "official_gemini_api",
            source: QUOTA_URL,
            status: "unavailable",
        },
    };
}

function parseBilling(document) {
    const balance = emptySnapshot(null, "balance_not_exposed").balance;
    if (!document.headings.includes("Gemini API Billing")) return balance;
    const billingId = new URL(document.url).searchParams.get("billing");
    balance.billingAccountId = /^[A-Z0-9]{6}(?:-[A-Z0-9]{6}){2}$/i.test(billingId || "") ? billingId : null;
    if (/Prepay credits depleted for /i.test(document.text)) balance.billingStatus = "prepay_depleted";
    else if (/A credit balance above \$0 is required to resume service\./.test(document.text)) {
        balance.billingStatus = "positive_prepay_required";
    }
    const seen = new Set();
    for (const text of document.labels) {
        const match = normalized(text).match(/^(.+?) eligible GCP credits$/);
        if (!match || seen.has(match[1])) continue;
        const amount = money(match[1]);
        if (!amount) continue;
        seen.add(match[1]);
        balance.eligibleGcpCredits.push({ ...amount, label: "Eligible GCP credits", source: BILLING_URL });
    }
    // The eligible-credit badge is not the prepaid balance. A depleted warning
    // also does not expose an exact balance, which could be zero or negative.
    if (balance.eligibleGcpCredits.length) {
        balance.status = "partial";
        balance.reason = "prepaid_not_exposed";
    }
    return balance;
}

function parseCredits(document) {
    const table = document.tables.find(table =>
        ["Credit name", "Status", "Remaining value", "Usage scope", "End date"].every(header =>
            table.headers.includes(header)
        )
    );
    if (!table) return null;
    const column = label => table.headers.indexOf(label);
    const rows = table.rows.filter(
        row => row[column("Credit name")] && /^(available|expired|used)$/i.test(normalized(row[column("Status")]))
    );
    if (!rows.length) return null;
    return rows.map(row => {
        const remaining = money(row[column("Remaining value")]);
        const original = money(row[column("Original value")]);
        return {
            currency: remaining?.currency || original?.currency || null,
            displayValue: remaining?.displayValue || null,
            expiresAt: date(row[column("End date")]),
            name: normalized(row[column("Credit name")]).slice(0, 300),
            original: original?.amount ?? null,
            remaining: remaining?.amount ?? null,
            scope: normalized(row[column("Usage scope")]).slice(0, 1000),
            source: CREDITS_URL,
            startsAt: date(row[column("Start date")]),
            status: normalized(row[column("Status")]).toLowerCase().slice(0, 40),
        };
    });
}

function parseQuota(document) {
    const quota = emptySnapshot(null, "quota_not_exposed").quota;
    if (!document.headings.includes("Gemini API Rate Limit")) return quota;
    const project = new URL(document.url).searchParams.get("project");
    quota.projectId = project && /^[a-zA-Z0-9:_-]{1,150}$/.test(project) ? project : null;
    // This official view reports a historical peak, not the current usage or
    // the remaining allowance. Never subtract its numerator from the limit.
    if (!/Peak usage per model compared to its limit over the last 28 days/.test(document.text)) return quota;
    for (const table of document.tables) {
        if (!["Model", "RPM", "TPM", "RPD"].every(header => table.headers.includes(header))) continue;
        for (const row of table.rows) {
            const model = normalized(row[table.headers.indexOf("Model")]);
            if (!model) continue;
            for (const unit of ["RPM", "TPM", "RPD"]) {
                const match = normalized(row[table.headers.indexOf(unit)]).match(/^([^/]+)\s*\/\s*([^/]+)$/);
                if (!match) continue;
                const limit = quantity(match[2]);
                const peakUsed = quantity(match[1]);
                if (limit === null) continue;
                quota.limits.push({
                    label: `${model} ${unit}`,
                    limit,
                    model: model.slice(0, 200),
                    peakUsed,
                    remaining: null,
                    resetAt: null,
                    unit,
                    used: null,
                    window: "last-28-days",
                });
            }
        }
    }
    if (quota.limits.length) {
        quota.reason = "historical_peak_not_remaining";
        quota.status = "available";
        quota.truncated = /See more/.test(document.text);
    }
    return quota;
}

/** Read official account pages without navigating or generating on the API page. */
class AccountInsightsService {
    constructor(serverSystem, options = {}) {
        this.serverSystem = serverSystem;
        this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
        this.timeoutMs = options.timeoutMs ?? 55000;
        this.pageTimeoutMs = options.pageTimeoutMs ?? 20000;
        this.now = options.now || Date.now;
        this.cache = new Map();
        this.inFlight = new Map();
    }

    _identity(index) {
        const { authSource, browserManager } = this.serverSystem;
        if (!Number.isInteger(index) || index < 0 || !authSource?.availableIndices?.includes(index)) return null;
        if (authSource.expiredIndices?.includes(index)) return null;
        const auth = authSource.getAuth(index);
        if (!auth) return null;
        const accountName = authSource.accountNameMap?.get(index) || auth.accountName || "";
        const emails = String(accountName).match(EMAIL_PATTERN) || [];
        const expectedEmail = emails.length === 1 ? emails[0].toLowerCase() : null;
        return {
            context: browserManager?.contexts?.get(index)?.context || null,
            expectedEmail,
            fingerprint: crypto.createHash("sha256").update(JSON.stringify({ accountName, auth })).digest("hex"),
        };
    }

    _sameIdentity(a, b) {
        return Boolean(a && b && a.context === b.context && a.fingerprint === b.fingerprint);
    }

    async get(index, { refresh = false } = {}) {
        const identity = this._identity(index);
        const unavailable = reason => emptySnapshot(new Date(this.now()).toISOString(), reason);
        if (!identity) return unavailable("account_unavailable");
        if (!identity.expectedEmail) return unavailable("account_identity_unconfirmed");
        if (!identity.context) return unavailable("browser_context_unavailable");
        const cached = this.cache.get(index);
        if (!refresh && this._sameIdentity(identity, cached?.identity) && this.now() - cached.at < this.ttlMs) {
            return clone(cached.snapshot);
        }
        const pending = this.inFlight.get(index);
        if (this._sameIdentity(identity, pending?.identity)) return clone(await pending.promise);
        const promise = this._collect(identity).then(snapshot => {
            if (!this._sameIdentity(identity, this._identity(index))) return unavailable("account_session_changed");
            this.cache.set(index, { at: this.now(), identity, snapshot });
            return snapshot;
        });
        const entry = { identity, promise };
        this.inFlight.set(index, entry);
        try {
            return clone(await promise);
        } finally {
            if (this.inFlight.get(index) === entry) this.inFlight.delete(index);
        }
    }

    async _collect(identity) {
        const snapshot = emptySnapshot(new Date(this.now()).toISOString(), "balance_not_exposed");
        snapshot.quota.reason = "quota_not_exposed";
        const pages = new Set();
        const state = { deadline: this.now() + this.timeoutMs, stopped: false };
        let timer;
        const task = (async () => {
            try {
                const billing = await this._readPage(identity, `${BILLING_URL}?hl=en`, "billing", pages, state);
                if (state.stopped) return;
                snapshot.balance = parseBilling(billing);
            } catch (error) {
                if (state.stopped) return;
                snapshot.balance.reason = error.code || "billing_page_unavailable";
            }
            try {
                const quota = await this._readPage(identity, `${QUOTA_URL}?hl=en`, "quota", pages, state);
                if (state.stopped) return;
                snapshot.quota = parseQuota(quota);
                if (/Prepay credits depleted for /i.test(quota.text))
                    snapshot.balance.billingStatus = "prepay_depleted";
            } catch (error) {
                if (state.stopped) return;
                snapshot.quota.reason = error.code || "quota_page_unavailable";
            }
            if (!snapshot.balance.billingAccountId || state.stopped) return;
            try {
                const url = `https://console.cloud.google.com/billing/${snapshot.balance.billingAccountId}/credits?hl=en`;
                const credits = await this._readPage(identity, url, "credits", pages, state);
                if (state.stopped) return;
                const rows = parseCredits(credits);
                if (rows !== null) {
                    snapshot.balance.promotionalCredits = rows;
                    snapshot.balance.status = "partial";
                    snapshot.balance.reason = "prepaid_not_exposed";
                } else snapshot.balance.promotionalCreditsReason = "promotional_credits_not_exposed";
            } catch (error) {
                if (state.stopped) return;
                snapshot.balance.promotionalCreditsReason = error.code || "credits_page_unavailable";
            }
        })();
        try {
            await Promise.race([
                task,
                new Promise((resolve, reject) => {
                    timer = setTimeout(
                        () => reject(Object.assign(new Error("Refresh timed out"), { code: "refresh_timeout" })),
                        this.timeoutMs
                    );
                }),
            ]);
        } catch (error) {
            if (snapshot.balance.status === "unavailable")
                snapshot.balance.reason = error.code || "billing_page_unavailable";
            if (snapshot.quota.status === "unavailable") snapshot.quota.reason = error.code || "quota_page_unavailable";
            snapshot.refreshReason = error.code || "refresh_failed";
        } finally {
            state.stopped = true;
            clearTimeout(timer);
            await Promise.allSettled([...pages].map(page => this._closePage(page)));
            snapshot.checkedAt = new Date(this.now()).toISOString();
        }
        return snapshot;
    }

    async _closePage(page) {
        let timer;
        try {
            await Promise.race([
                page.close({ runBeforeUnload: false }).catch(() => {}),
                new Promise(resolve => {
                    timer = setTimeout(resolve, 1000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    async _readPage(identity, url, kind, pages, state) {
        if (state.stopped || this.now() >= state.deadline)
            throw Object.assign(new Error("Refresh timed out"), { code: "refresh_timeout" });
        const page = await identity.context.newPage();
        pages.add(page);
        try {
            if (state.stopped) throw Object.assign(new Error("Refresh timed out"), { code: "refresh_timeout" });
            const timeout = () => Math.max(1, Math.min(this.pageTimeoutMs, state.deadline - this.now()));
            await page.goto(url, { timeout: timeout(), waitUntil: "domcontentloaded" });
            const finalUrl = new URL(page.url());
            if (finalUrl.hostname === "accounts.google.com")
                throw Object.assign(new Error("Sign-in required"), { code: "account_session_expired" });
            if (finalUrl.hostname !== new URL(url).hostname)
                throw Object.assign(new Error("Unexpected redirect"), { code: "official_page_redirected" });
            await page
                .waitForFunction(
                    pageKind => {
                        const text = document.body.innerText;
                        if (pageKind === "billing")
                            return /eligible GCP credits|Available credits|No billing accounts/.test(text);
                        const tables = [...document.querySelectorAll("table")];
                        if (pageKind === "credits")
                            return tables.some(table => {
                                const headers = [...table.querySelectorAll("th")].map(cell => cell.textContent.trim());
                                const statusIndex = headers.indexOf("Status");
                                const valueIndex = headers.indexOf("Remaining value");
                                if (statusIndex < 0 || valueIndex < 0) return false;
                                return [...table.querySelectorAll("tr")].some(row => {
                                    const cells = [...row.querySelectorAll("td")];
                                    return (
                                        /^(available|expired|used)$/i.test(
                                            cells[statusIndex]?.innerText.trim() || ""
                                        ) && /\d/.test(cells[valueIndex]?.innerText || "")
                                    );
                                });
                            });
                        return tables.some(
                            table =>
                                /\bRPM\b/.test(table.innerText) &&
                                [...table.querySelectorAll("tbody td")].some(cell => /\d\s*\//.test(cell.textContent))
                        );
                    },
                    kind,
                    { timeout: timeout() }
                )
                .catch(() => {});
            const documentSnapshot = await page.evaluate(
                pageKind => ({
                    headings: [...document.querySelectorAll("h1,h2")].map(node => node.textContent.trim()),
                    identityLabels: [
                        ...document.querySelectorAll(
                            pageKind === "credits"
                                ? "button.cfc-accountchooser-link[aria-label]"
                                : "button.account-switcher-button[aria-label]"
                        ),
                    ]
                        .map(node => node.getAttribute("aria-label").trim())
                        .filter(label =>
                            pageKind === "credits" ? /^Account:/.test(label) : /^Google Account:/.test(label)
                        ),
                    labels: [...document.querySelectorAll("body *")]
                        .filter(node => !node.children.length)
                        .map(node => node.textContent.trim())
                        .filter(text => /eligible GCP credits/.test(text)),
                    tables: [...document.querySelectorAll("table")].map(table => ({
                        headers: [...table.querySelectorAll("th")].map(cell => cell.textContent.trim()),
                        rows: [...table.querySelectorAll("tr")].map(row =>
                            [...row.querySelectorAll("td")].map(cell => cell.innerText.trim())
                        ),
                    })),
                    text: document.body.innerText,
                }),
                kind
            );
            const visibleEmails = [
                ...new Set(
                    documentSnapshot.identityLabels
                        .flatMap(label => label.match(EMAIL_PATTERN) || [])
                        .map(email => email.toLowerCase())
                ),
            ];
            if (visibleEmails.length !== 1 || visibleEmails[0] !== identity.expectedEmail) {
                throw Object.assign(new Error("Account identity is unconfirmed"), {
                    code: "account_identity_unconfirmed",
                });
            }
            if (kind === "credits") {
                const requestedAccount = new URL(url).pathname.split("/")[2];
                const displayedAccount = new URL(page.url()).pathname.split("/")[2];
                if (requestedAccount !== displayedAccount) {
                    throw Object.assign(new Error("Billing account selection changed"), {
                        code: "billing_account_selection_required",
                    });
                }
            }
            return { ...documentSnapshot, url: page.url() };
        } finally {
            await this._closePage(page);
            pages.delete(page);
        }
    }
}

module.exports = AccountInsightsService;
module.exports.parseBilling = parseBilling;
module.exports.parseCredits = parseCredits;
module.exports.parseQuota = parseQuota;
