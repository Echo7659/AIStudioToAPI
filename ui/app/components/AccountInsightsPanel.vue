<template>
    <section class="insights-panel" :aria-label="t('accountInsightsTitle')">
        <div class="panel-heading">
            <div>
                <h4>{{ t("accountInsightsTitle") }}</h4>
                <p>{{ t("accountInsightsDescription") }}</p>
            </div>
            <div class="insights-controls">
                <el-select
                    v-model="activeIndex"
                    :aria-label="t('accountInsightsSelectAccount')"
                    :placeholder="t('accountInsightsSelectAccount')"
                    size="small"
                    :disabled="busy || loading || !pickerAccounts.length"
                    class="account-select"
                >
                    <el-option
                        v-for="account in pickerAccounts"
                        :key="account.key"
                        :label="accountLabel(account)"
                        :value="account.key"
                    />
                </el-select>
                <el-button
                    size="small"
                    :loading="loading"
                    :disabled="busy || activeIndex === null"
                    @click="loadInsights(true)"
                >
                    {{ t("accountInsightsRefresh") }}
                </el-button>
            </div>
        </div>

        <p v-if="!pickerAccounts.length" class="notice">{{ t("accountInsightsNoAccounts") }}</p>
        <p v-else-if="loadError" class="notice error" role="alert">
            {{ t(loadErrorCode === "system_busy" ? "accountInsightsSystemBusy" : "accountInsightsLoadFailed") }}
        </p>
        <p v-if="loading" class="notice" role="status">{{ t("accountInsightsLoading") }}</p>
        <p v-if="selectedAccount?.kind === 'oauth'" class="notice">{{ t("accountInsightsOAuthFinanceHelp") }}</p>
        <div v-if="snapshot" class="insights-grid" :aria-busy="loading">
            <div class="insight-card">
                <div class="insight-heading">
                    <h5>{{ t("accountInsightsBalance") }}</h5>
                    <el-tag :type="statusType(snapshot.balance?.status)" effect="plain" size="small">
                        {{ statusLabel(snapshot.balance?.status) }}
                    </el-tag>
                </div>
                <div v-if="snapshot.balance?.eligibleGcpCredits?.length" class="eligible-overview">
                    <div v-for="(credit, index) in snapshot.balance.eligibleGcpCredits" :key="index">
                        <div class="balance-value">
                            {{
                                money(credit.amount, credit.currency || snapshot.balance.currency, credit.displayValue)
                            }}
                        </div>
                        <p class="notice">{{ t("accountInsightsEligibleGcpCredits") }}</p>
                    </div>
                    <p class="notice fine-print">{{ t("accountInsightsEligibleGcpCreditsHint") }}</p>
                </div>
                <div
                    class="prepaid-overview"
                    :class="{ 'secondary-balance': snapshot.balance?.eligibleGcpCredits?.length }"
                >
                    <span class="notice">{{ t("accountInsightsPrepaidLabel") }}</span>
                    <strong>{{
                        money(
                            snapshot.balance?.prepaid,
                            snapshot.balance?.currency,
                            snapshot.balance?.prepaidDisplayValue
                        )
                    }}</strong>
                </div>
                <p v-if="snapshot.balance?.billingStatus" class="notice">
                    {{
                        t("accountInsightsBillingStatus", {
                            status: billingStatusLabel(snapshot.balance.billingStatus),
                        })
                    }}
                </p>
                <p v-if="snapshot.balance?.reason" class="notice">
                    {{ reasonText(snapshot.balance.reason, "balance") }}
                </p>
                <details v-if="snapshot.balance?.promotionalCredits?.length" class="promotional-credits">
                    <summary>
                        {{
                            t("accountInsightsPromotionalCreditCount", {
                                count: snapshot.balance.promotionalCredits.length,
                            })
                        }}
                    </summary>
                    <ul class="credit-list">
                        <li v-for="(credit, index) in snapshot.balance.promotionalCredits" :key="index">
                            <div class="credit-heading">
                                <span>{{ credit.name || t("accountInsightsCreditName", { index: index + 1 }) }}</span>
                                <strong>{{
                                    money(
                                        credit.remaining,
                                        credit.currency || snapshot.balance.currency,
                                        credit.displayValue
                                    )
                                }}</strong>
                            </div>
                            <p v-if="credit.status" class="notice">
                                {{ t("accountInsightsCreditStatus", { status: creditStatusLabel(credit.status) }) }}
                            </p>
                            <p v-if="credit.startsAt" class="notice">
                                {{ t("accountInsightsStarts", { time: formatTime(credit.startsAt) }) }}
                            </p>
                            <p v-if="credit.expiresAt" class="notice">
                                {{ t("accountInsightsExpires", { time: formatTime(credit.expiresAt) }) }}
                            </p>
                            <p class="notice">
                                {{ t("accountInsightsScope", { scope: formatScope(credit.scope) }) }}
                            </p>
                        </li>
                    </ul>
                    <p class="notice fine-print">{{ t("accountInsightsCreditsSeparate") }}</p>
                </details>
                <p v-else class="notice">
                    {{
                        snapshot.balance?.promotionalCreditsReason
                            ? reasonText(snapshot.balance.promotionalCreditsReason, "credits")
                            : t("accountInsightsCreditsUnknown")
                    }}
                </p>
                <div class="source-links">
                    <a
                        :href="sourceUrl(snapshot.balance?.source, 'https://aistudio.google.com/billing')"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {{ t("accountInsightsOfficialBilling") }}
                    </a>
                    <a
                        href="https://console.cloud.google.com/billing/credits"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {{ t("accountInsightsOfficialCredits") }}
                    </a>
                </div>
            </div>

            <div class="insight-card">
                <div class="insight-heading">
                    <h5>{{ t("accountInsightsQuota") }}</h5>
                    <el-tag :type="statusType(snapshot.quota?.status)" effect="plain" size="small">
                        {{ statusLabel(snapshot.quota?.status) }}
                    </el-tag>
                </div>
                <details
                    v-if="snapshot.quota?.limits?.length"
                    :open="snapshot.quota.limits.length <= 6"
                    class="quota-details"
                >
                    <summary>{{ t("accountInsightsQuotaCount", { count: snapshot.quota.limits.length }) }}</summary>
                    <div class="quota-scroll">
                        <table class="quota-table">
                            <caption class="visually-hidden">
                                {{
                                    t("accountInsightsQuota")
                                }}
                            </caption>
                            <thead>
                                <tr>
                                    <th scope="col">{{ t("accountInsightsQuotaMetric") }}</th>
                                    <th scope="col">
                                        {{ t(hasPeakQuota ? "accountInsightsQuotaPeak" : "accountInsightsQuotaUsed") }}
                                    </th>
                                    <th scope="col">{{ t("accountInsightsQuotaLimit") }}</th>
                                    <th v-if="!hasPeakQuota" scope="col">{{ t("accountInsightsQuotaRemaining") }}</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="(limit, index) in snapshot.quota.limits" :key="index">
                                    <th scope="row">
                                        {{ limit.model || limit.label || t("accountInsightsQuotaMetric") }}
                                        <span v-if="limit.unit" class="metric-detail">{{ limit.unit }}</span>
                                        <span v-if="limit.resetAt" class="metric-detail">{{
                                            t("accountInsightsResets", { time: formatTime(limit.resetAt) })
                                        }}</span>
                                    </th>
                                    <td>{{ quantity(hasPeakQuota ? limit.peakUsed : limit.used) }}</td>
                                    <td>{{ quantity(limit.limit) }}</td>
                                    <td v-if="!hasPeakQuota">{{ quantity(limit.remaining) }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </details>
                <p v-if="!snapshot.quota?.limits?.length || snapshot.quota?.reason" class="notice">
                    {{
                        snapshot.quota?.reason
                            ? reasonText(snapshot.quota.reason, "quota")
                            : t("accountInsightsQuotaUnavailable")
                    }}
                </p>
                <p v-if="snapshot.quota?.truncated" class="notice">{{ t("accountInsightsQuotaTruncated") }}</p>
                <p class="notice fine-print">{{ t("accountInsightsQuotaExplanation") }}</p>
                <div class="source-links">
                    <a
                        :href="sourceUrl(snapshot.quota?.source, 'https://aistudio.google.com/rate-limit')"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {{ t("accountInsightsOfficialUsage") }}
                    </a>
                </div>
            </div>
        </div>
        <p v-if="snapshot?.checkedAt" class="checked-at">
            {{ t("accountInsightsCheckedAt", { time: formatTime(snapshot.checkedAt) }) }}
        </p>
        <p v-if="snapshot?.refreshReason" class="notice error">{{ reasonText(snapshot.refreshReason, "balance") }}</p>
        <p v-if="snapshot" class="notice fine-print">{{ t("accountInsightsRefreshHint") }}</p>
    </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import I18n from "../utils/i18n";

const props = defineProps({
    accounts: { default: () => [], type: Array },
    busy: { default: false, type: Boolean },
    oauthAccounts: { default: () => [], type: Array },
    selectedIndex: { default: null, type: [Number, String] },
});
const emit = defineEmits(["update:selectedIndex"]);
const langVersion = ref(I18n.state.version);
const t = (key, options) => {
    langVersion.value;
    return I18n.t(key, options);
};
const selected = ref(props.selectedIndex);
const pickerAccounts = computed(() => [
    ...props.accounts.map(account => ({
        key: account.index,
        kind: "browser",
        name: account.name || `#${account.index}`,
    })),
    ...props.oauthAccounts.map(account => ({
        id: account.id,
        key: `oauth:${account.id}`,
        kind: "oauth",
        name: t("accountInsightsOAuthAccountLabel", { account: account.email || t("oauthUnverifiedAccount") }),
    })),
]);
const activeIndex = computed({
    get: () => selected.value,
    set: value => {
        selected.value = value;
        emit("update:selectedIndex", value);
    },
});
const snapshot = ref(null);
const selectedAccount = computed(() =>
    pickerAccounts.value.find(account => String(account.key) === String(activeIndex.value))
);
const hasPeakQuota = computed(() =>
    snapshot.value?.quota?.limits?.some(limit => limit.window === "last-28-days" || typeof limit.peakUsed === "number")
);
const loading = ref(false);
const loadError = ref(false);
const loadErrorCode = ref("");
let requestNumber = 0;
let requestController;
let mounted = true;
let stopLanguageListener;

const accountLabel = account => account.name;
const quantity = value =>
    typeof value === "number" && Number.isFinite(value)
        ? value.toLocaleString(I18n.getLang())
        : t("accountInsightsUnknown");
const money = (value, currency, displayValue) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return t("accountInsightsUnknown");
    if (typeof displayValue === "string" && displayValue.length < 80) return displayValue;
    if (typeof currency === "string" && /^[A-Z]{3}$/.test(currency)) {
        return new Intl.NumberFormat(I18n.getLang(), { currency, style: "currency" }).format(value);
    }
    return `${quantity(value)} ${t("accountInsightsCurrencyUnknown")}`;
};
const formatTime = value => {
    const date = new Date(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
    return Number.isNaN(date.getTime()) ? t("accountInsightsUnknown") : date.toLocaleString(I18n.getLang());
};
const formatScope = scope => {
    if (Array.isArray(scope))
        return scope.filter(item => typeof item === "string").join(", ") || t("accountInsightsUnknown");
    return typeof scope === "string" && scope ? scope : t("accountInsightsUnknown");
};
const statusType = status => ({ available: "success", partial: "warning" })[status] || "info";
const creditStatusLabel = status => {
    const keys = {
        available: "accountInsightsCreditAvailable",
        exhausted: "accountInsightsCreditExhausted",
        expired: "accountInsightsCreditExpired",
        used: "accountInsightsCreditExhausted",
    };
    return t(keys[String(status).toLowerCase()] || "accountInsightsUnknown");
};
const billingStatusLabel = status => {
    const keys = {
        needs_prepaid_credit: "accountInsightsNeedsPrepaidCredit",
        positive_prepay_required: "accountInsightsNeedsPrepaidCredit",
        prepay_depleted: "accountInsightsPrepayDepleted",
    };
    return keys[status] ? t(keys[status]) : status;
};
const statusLabel = status => {
    const keys = { available: "accountInsightsStatusAvailable", partial: "accountInsightsStatusPartial" };
    return t(keys[status] || "accountInsightsStatusUnavailable");
};

const reasonKeys = {
    account_identity_unconfirmed: "accountInsightsIdentityUnconfirmed",
    account_mismatch: "accountInsightsAccountMismatch",
    account_session_changed: "accountInsightsSessionChanged",
    account_session_expired: "accountInsightsBrowserRequired",
    account_unavailable: "accountInsightsAccountUnavailable",
    balance_not_exposed: "accountInsightsBalanceUnavailable",
    billing_account_selection_required: "accountInsightsBillingAccountSelection",
    billing_page_unavailable: "accountInsightsBillingUnavailable",
    browser_context_unavailable: "accountInsightsBrowserRequired",
    browser_login_required: "accountInsightsBrowserRequired",
    credits_page_unavailable: "accountInsightsCreditsUnavailable",
    historical_peak_not_remaining: "accountInsightsHistoricalPeak",
    not_signed_in: "accountInsightsBrowserRequired",
    oauth_identity_unverified: "accountInsightsOAuthIdentityUnverified",
    official_page_redirected: "accountInsightsOfficialPageRedirected",
    prepaid_not_exposed: "accountInsightsBalanceUnavailable",
    promotional_credits_not_exposed: "accountInsightsCreditsUnknown",
    quota_not_exposed: "accountInsightsQuotaUnavailable",
    quota_page_unavailable: "accountInsightsQuotaPageUnavailable",
    refresh_failed: "accountInsightsLoadFailed",
    refresh_timeout: "accountInsightsTimeout",
    request_timeout: "accountInsightsTimeout",
};
const reasonText = (reason, section) => {
    const fallbackKeys = {
        balance: "accountInsightsBalanceUnavailable",
        credits: "accountInsightsCreditsUnknown",
        quota: "accountInsightsQuotaUnavailable",
    };
    return t(reasonKeys[reason] || fallbackKeys[section]);
};

const sourceUrl = (source, fallback) => {
    if (typeof source !== "string") return fallback;
    try {
        const url = new URL(source);
        if (url.protocol === "https:" && (url.hostname === "google.com" || url.hostname.endsWith(".google.com")))
            return url.href;
    } catch {
        // A source can be a descriptive label rather than a URL.
    }
    return fallback;
};

const loadInsights = async (refresh = false) => {
    const index = activeIndex.value;
    if (index === null || index === undefined) return;
    requestController?.abort();
    requestController = new AbortController();
    const controller = requestController;
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, 120000);
    const currentRequest = ++requestNumber;
    loading.value = true;
    loadError.value = false;
    loadErrorCode.value = "";
    try {
        const basePath =
            selectedAccount.value?.kind === "oauth"
                ? `/api/oauth/accounts/${encodeURIComponent(selectedAccount.value.id)}/insights`
                : `/api/accounts/${encodeURIComponent(index)}/insights`;
        const path = `${basePath}${refresh ? "/refresh" : ""}`;
        const response = await fetch(path, {
            cache: "no-store",
            method: refresh ? "POST" : "GET",
            signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) {
            if (currentRequest === requestNumber && data.code === "system_busy") loadErrorCode.value = "system_busy";
            throw new Error("request_failed");
        }
        if (currentRequest === requestNumber) snapshot.value = data;
    } catch (error) {
        if ((error.name !== "AbortError" || timedOut) && currentRequest === requestNumber) {
            loadError.value = true;
            snapshot.value = null;
        }
    } finally {
        clearTimeout(timeout);
        if (currentRequest === requestNumber) loading.value = false;
    }
};

watch(
    () => props.selectedIndex,
    value => {
        if (pickerAccounts.value.some(account => String(account.key) === String(value))) selected.value = value;
    }
);

// Account status polling changes objects, so watch stable indices instead of the array itself.
watch(
    () => pickerAccounts.value.map(account => account.key).join(","),
    () => {
        if (!pickerAccounts.value.some(account => String(account.key) === String(activeIndex.value))) {
            activeIndex.value = pickerAccounts.value[0]?.key ?? null;
        }
    },
    { immediate: true }
);

watch(
    activeIndex,
    () => {
        snapshot.value = null;
        if (activeIndex.value === null) {
            requestController?.abort();
            requestNumber++;
            loading.value = false;
            loadError.value = false;
            return;
        }
        loadInsights();
    },
    { immediate: true }
);

onMounted(() => {
    stopLanguageListener = I18n.onChange(() => {
        if (mounted) langVersion.value = I18n.state.version;
    });
});
onBeforeUnmount(() => {
    mounted = false;
    if (typeof stopLanguageListener === "function") stopLanguageListener();
    requestController?.abort();
});
</script>

<style scoped lang="less">
.insights-panel {
    margin-top: 18px;
    padding-top: 18px;
    border-top: 1px solid var(--border-light);
    color: var(--text-primary);
}
.panel-heading,
.insights-controls,
.insight-heading,
.credit-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
}
.panel-heading {
    align-items: flex-start;
    flex-wrap: wrap;
}
.panel-heading h4 {
    margin: 0 0 6px;
    font-size: 15px;
}
.panel-heading p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.6;
}
.insights-controls {
    flex-wrap: wrap;
}
.account-select {
    width: 230px;
    max-width: 100%;
}
.insights-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    margin-top: 14px;
}
.insight-card {
    border: 1px solid var(--border-light);
    border-radius: 8px;
    padding: 15px;
    min-width: 0;
}
.insight-heading {
    margin-bottom: 14px;
}
.insight-heading h5 {
    font-size: 14px;
    margin: 0;
}
.balance-value {
    font-size: 26px;
    font-weight: 600;
    overflow-wrap: anywhere;
}
.notice,
.checked-at {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.6;
    margin: 8px 0 0;
    overflow-wrap: anywhere;
}
.notice.error {
    color: var(--color-error);
}
.fine-print,
.checked-at {
    font-size: 12px;
}
.checked-at {
    margin-top: 12px;
}
.promotional-credits {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--border-light);
}
summary {
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
}
summary:hover {
    color: var(--color-primary);
}
.prepaid-overview {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
}
.prepaid-overview strong {
    font-size: 20px;
}
.prepaid-overview.secondary-balance strong {
    font-size: 14px;
}
.eligible-overview + .prepaid-overview {
    padding-top: 12px;
    border-top: 1px solid var(--border-light);
}
.credit-list {
    list-style: none;
    padding: 0;
    margin: 0;
}
.credit-list li {
    padding: 10px 0;
    border-bottom: 1px solid var(--border-light);
}
.credit-heading {
    font-size: 13px;
    align-items: flex-start;
    overflow-wrap: anywhere;
}
.credit-heading strong {
    flex-shrink: 0;
}
.source-links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    margin-top: 14px;
}
.source-links a {
    color: var(--color-primary);
    font-size: 12px;
    text-decoration: none;
}
.source-links a:hover {
    text-decoration: underline;
}
.quota-scroll {
    overflow-x: auto;
}
.quota-table {
    width: 100%;
    border-collapse: collapse;
    text-align: right;
    font-size: 12px;
}
.quota-table th,
.quota-table td {
    padding: 8px 6px;
    border-bottom: 1px solid var(--border-light);
    vertical-align: top;
}
.quota-table th {
    font-weight: 500;
    color: var(--text-secondary);
}
.quota-table th:first-child {
    text-align: left;
}
.quota-table tbody th {
    color: var(--text-primary);
    overflow-wrap: anywhere;
}
.metric-detail {
    display: block;
    font-weight: normal;
    color: var(--text-secondary);
    margin-top: 4px;
}
.visually-hidden {
    position: absolute;
    height: 1px;
    width: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
}
@media (max-width: 800px) {
    .insights-grid {
        grid-template-columns: minmax(0, 1fr);
    }
}
@media (max-width: 480px) {
    .insights-controls {
        width: 100%;
    }
    .account-select {
        flex: 1;
        min-width: 130px;
    }
}
</style>
