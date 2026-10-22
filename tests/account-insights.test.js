const assert = require("node:assert/strict");
const test = require("node:test");
const AccountInsightsService = require("../src/core/AccountInsightsService");
const { parseBilling, parseCredits, parseQuota } = AccountInsightsService;

// Sanitized fixtures from the official pages; these are different balances and
// scopes. In particular, the free-trial row must not inflate eligible credits.
const billing = {
    headings: ["Gemini API Billing"],
    identityLabels: ["Google Account: Example (owner@example.com)"],
    labels: ["$30 eligible GCP credits"],
    tables: [],
    text: "Gemini API Billing\nA credit balance above $0 is required to resume service.\n$30 eligible GCP credits\nPaid 1\n· $250 Billing Account Tier Cap",
    url: "https://aistudio.google.com/billing?hl=en&billing=AAAAAA-BBBBBB-CCCCCC",
};
const credits = {
    headings: ["Credits"],
    identityLabels: billing.identityLabels,
    labels: [],
    tables: [
        {
            headers: [
                "Credit name",
                "Status",
                "Percent remaining",
                "Remaining value",
                "Original value",
                "Type",
                "Credit ID",
                "Usage scope",
                "Start date",
                "End date",
            ],
            rows: [
                [
                    "Free Trial",
                    "Available",
                    "100%",
                    "$299.99",
                    "$300.00",
                    "One-time",
                    "omitted",
                    "Certain usage; see the terms for free trial.",
                    "October 18, 2026",
                    "January 17, 2027",
                ],
                [
                    "Google Developer Program premium benefit",
                    "Available",
                    "100%",
                    "$10.00",
                    "$10.00",
                    "One-time",
                    "omitted",
                    "Following services: all of Google Cloud Platform and Google Maps APIs.",
                    "October 18, 2026",
                    "February 5, 2027",
                ],
                [
                    "Free Trial",
                    "Expired",
                    "—",
                    "$300.00",
                    "$300.00",
                    "One-time",
                    "omitted",
                    "Certain usage; see the terms for free trial.",
                    "October 18, 2026",
                    "October 18, 2026",
                ],
            ],
        },
    ],
    text: "Credits\nIssued Credits",
    url: "https://console.cloud.google.com/billing/AAAAAA-BBBBBB-CCCCCC/credits/all?hl=en",
};
const quota = {
    headings: ["Gemini API Rate Limit"],
    identityLabels: billing.identityLabels,
    labels: [],
    tables: [
        {
            headers: ["Status", "Model", "Category", "RPM", "TPM", "RPD", "Charts"],
            rows: [[], ["check", "Gemini 3.1 Pro", "Text-out models", "1 / 25", "1 / 2M", "1 / 250", "bar_chart"]],
        },
    ],
    text: "Peak usage per model compared to its limit over the last 28 days\nSee more",
    url: "https://aistudio.google.com/rate-limit?hl=en&timeRange=last-28-days&project=example-project",
};

function harness(options = {}) {
    const auth = { accountName: "owner@example.com", cookies: [{ value: "fixture-cookie" }], origins: [] };
    const calls = { close: 0, pages: 0, urls: [] };
    const context = {
        async newPage() {
            calls.pages++;
            let url;
            return {
                async close() {
                    calls.close++;
                },
                async evaluate() {
                    const fixture = url.includes("console.cloud.google.com")
                        ? credits
                        : url.includes("rate-limit")
                          ? quota
                          : billing;
                    const copy = structuredClone(fixture);
                    if (options.email) copy.identityLabels = [`Google Account: Example (${options.email})`];
                    return copy;
                },
                async goto(target) {
                    calls.urls.push(target);
                    url = target;
                    if (options.goto) await options.goto();
                },
                url() {
                    if (url.includes("console.cloud.google.com")) return options.creditsUrl || credits.url;
                    return url.includes("rate-limit") ? quota.url : billing.url;
                },
                async waitForFunction() {},
            };
        },
    };
    const server = {
        authSource: {
            accountNameMap: new Map([[0, auth.accountName]]),
            availableIndices: [0],
            expiredIndices: [],
            getAuth: () => auth,
        },
        browserManager: { contexts: new Map([[0, { context }]]) },
    };
    return { auth, calls, context, server };
}

test("eligible GCP credit badge is separate from the unknown prepaid balance", () => {
    const result = parseBilling(billing);
    assert.equal(result.prepaid, null);
    assert.equal(result.status, "partial");
    assert.equal(result.billingStatus, "positive_prepay_required");
    assert.equal(result.eligibleGcpCredits[0].amount, 30);
    assert.equal(result.eligibleGcpCredits[0].displayValue, "$30");
    assert.equal(result.eligibleGcpCredits[0].currency, null, "An unqualified dollar sign is not an ISO currency");
    assert.deepEqual(result.promotionalCredits, []);
    const warningOnly = parseBilling({ ...billing, labels: [] });
    assert.equal(warningOnly.prepaid, null);
    assert.equal(warningOnly.status, "unavailable");
});

test("credits preserve expiry, status, and scope without summing trial or expired credit", () => {
    const rows = parseCredits(credits);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].remaining, 299.99);
    assert.equal(rows[0].expiresAt, "2027-01-17");
    assert.match(rows[0].scope, /free trial/);
    assert.equal(rows[1].remaining, 10);
    assert.equal(rows[2].status, "expired");
    assert.equal(rows[2].remaining, 300, "Preserve the official expired row, but do not call it usable");
    assert.equal(rows[0].creditId, undefined);
    assert.equal(parseCredits({ tables: [] }), null);
    assert.equal(
        parseCredits({
            ...credits,
            tables: [{ ...credits.tables[0], rows: [["Loading contents"]] }],
        }),
        null,
        "The initial loading row is not a credit or an empty balance"
    );
});

test("rate-limit numerators remain historical peaks and never become remaining quota", () => {
    const result = parseQuota(quota);
    assert.equal(result.status, "available");
    assert.equal(result.limits.length, 3);
    assert.equal(result.limits[1].limit, 2000000);
    assert.equal(result.limits[1].peakUsed, 1);
    assert.equal(result.limits[1].used, null);
    assert.equal(result.limits[1].remaining, null);
    assert.equal(result.truncated, true);
    assert.equal(parseQuota({ ...quota, text: "A different unknown view" }).limits.length, 0);
});

test("unknown and expired identities do not open a page", async () => {
    const fixture = harness();
    const service = new AccountInsightsService(fixture.server);
    assert.equal((await service.get(9)).balance.reason, "account_unavailable");
    fixture.server.authSource.accountNameMap.set(0, "A label without an email");
    assert.equal((await service.get(0)).balance.reason, "account_identity_unconfirmed");
    assert.equal(fixture.calls.pages, 0);
});

test("a mismatched visible account never returns billing, gift, or model data", async () => {
    const fixture = harness({ email: "other@example.com" });
    const result = await new AccountInsightsService(fixture.server).get(0);
    assert.equal(result.balance.reason, "account_identity_unconfirmed");
    assert.equal(result.quota.reason, "account_identity_unconfirmed");
    assert.equal(result.balance.billingAccountId, null);
    assert.deepEqual(result.balance.eligibleGcpCredits, []);
    assert.deepEqual(result.quota.limits, []);
    assert.equal(fixture.calls.close, fixture.calls.pages);
});

test("credits redirected to a different billing account cannot be attached to the selected account", async () => {
    const fixture = harness({
        creditsUrl: "https://console.cloud.google.com/billing/DDDDDD-EEEEEE-FFFFFF/credits/all?hl=en",
    });
    const result = await new AccountInsightsService(fixture.server).get(0);
    assert.equal(result.balance.promotionalCreditsReason, "billing_account_selection_required");
    assert.deepEqual(result.balance.promotionalCredits, []);
    assert.equal(result.balance.eligibleGcpCredits[0].amount, 30);
    assert.equal(fixture.calls.close, 3);
});

test("concurrent refreshes share work; cache binds the auth fingerprint and browser context", async () => {
    const fixture = harness();
    const service = new AccountInsightsService(fixture.server);
    const [first, second] = await Promise.all([service.get(0), service.get(0, { refresh: true })]);
    assert.deepEqual(first, second);
    assert.equal(first.balance.promotionalCredits.length, 3);
    assert.equal(fixture.calls.pages, 3);
    assert.equal(fixture.calls.close, 3);
    await service.get(0);
    assert.equal(fixture.calls.pages, 3);
    fixture.auth.cookies[0].value = "replacement-fixture-cookie";
    await service.get(0);
    assert.equal(fixture.calls.pages, 6);
    fixture.server.browserManager.contexts.set(0, { context: { ...fixture.context } });
    await service.get(0);
    assert.equal(fixture.calls.pages, 9);
    assert.ok(fixture.calls.urls.every(url => !url.includes("generateContent")));
});

test("an account replaced during refresh cannot publish the old account snapshot", async () => {
    let release;
    const gate = new Promise(resolve => {
        release = resolve;
    });
    const fixture = harness({ goto: () => gate });
    const service = new AccountInsightsService(fixture.server);
    const request = service.get(0);
    fixture.auth.cookies[0].value = "different-account-fixture-cookie";
    release();
    const result = await request;
    assert.equal(result.balance.reason, "account_session_changed");
    assert.deepEqual(result.balance.eligibleGcpCredits, []);
    assert.equal(service.cache.size, 0);
});

test("a stuck navigation has an absolute deadline and closes the temporary page", async () => {
    const fixture = harness({ goto: () => new Promise(() => {}) });
    const service = new AccountInsightsService(fixture.server, { timeoutMs: 15 });
    const result = await service.get(0);
    assert.equal(result.refreshReason, "refresh_timeout");
    assert.equal(result.balance.prepaid, null);
    assert.equal(fixture.calls.pages, 1);
    assert.equal(fixture.calls.close, 1);
});
