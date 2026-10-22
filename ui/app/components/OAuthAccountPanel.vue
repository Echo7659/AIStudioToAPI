<template>
    <section class="oauth-panel" :aria-label="t('oauthAccountsTitle')">
        <div class="panel-heading">
            <div>
                <h4>{{ t("oauthAccountsTitle") }}</h4>
                <p>{{ t("oauthAccountsDescription") }}</p>
            </div>
            <el-button size="small" :disabled="isBusy" @click="openImport">{{ t("oauthImportJson") }}</el-button>
        </div>

        <div class="channel-settings">
            <div class="channel-heading">
                <strong>{{ t("oauthChannelTitle") }}</strong>
                <el-tag v-if="channelLoaded" size="small" effect="plain">{{
                    t(savedChannel.mode === "oauth" ? "oauthChannelOfficial" : "oauthChannelBuild")
                }}</el-tag>
            </div>
            <div class="channel-controls">
                <el-select
                    v-model="channelMode"
                    :aria-label="t('oauthChannelTitle')"
                    :disabled="channelReadOnly"
                    size="small"
                    class="channel-select"
                    @change="prepareOAuthSelection"
                >
                    <el-option :label="t('oauthChannelBuild')" value="build" />
                    <el-option :label="t('oauthChannelOfficial')" value="oauth" />
                </el-select>
                <template v-if="channelMode === 'oauth'">
                    <el-select
                        v-model="channelAccountId"
                        :aria-label="t('oauthChannelAccount')"
                        :placeholder="t('oauthChannelAccount')"
                        :disabled="channelReadOnly || !oauthAccounts.length"
                        size="small"
                        class="channel-account-select"
                        @change="prefillProject"
                    >
                        <el-option
                            v-for="account in oauthAccounts"
                            :key="account.id"
                            :label="oauthAccountLabel(account)"
                            :value="account.id"
                        />
                    </el-select>
                    <el-input
                        v-model="channelProjectId"
                        :aria-label="t('oauthChannelProject')"
                        :placeholder="t('oauthChannelProject')"
                        :disabled="channelReadOnly"
                        maxlength="150"
                        size="small"
                        class="channel-project-input"
                    />
                </template>
                <el-button
                    size="small"
                    :loading="channelSaving"
                    :disabled="channelReadOnly || !channelDirty || !channelValid"
                    @click="saveChannel"
                    >{{ t("oauthChannelSave") }}</el-button
                >
            </div>
            <p v-if="channelManagedByEnvironment" class="notice">{{ t("oauthChannelManagedByEnvironment") }}</p>
            <p v-if="channelError" class="notice error" role="alert">{{ t(channelError) }}</p>
            <p v-if="channelMode === 'oauth'" class="notice">{{ t("oauthChannelOfficialHelp") }}</p>
            <p v-else class="notice">{{ t("oauthChannelBuildHelp") }}</p>
            <p
                v-if="channelMode === 'oauth' && selectedOAuthAccount && !selectedOAuthAccount.identityVerified"
                class="notice warning"
            >
                {{ t("oauthChannelLazyVerification") }}
            </p>
            <p v-if="channelDirty" class="notice">{{ t("oauthChannelUnsaved") }}</p>
        </div>

        <p v-if="loadError" class="notice error" role="alert">{{ t("oauthLoadFailed") }}</p>
        <p v-else-if="loading" class="notice" role="status">{{ t("loading") }}</p>
        <p v-else-if="!oauthAccounts.length" class="notice">{{ t("oauthNoAccounts") }}</p>

        <ul v-if="oauthAccounts.length" class="oauth-list">
            <li v-for="account in oauthAccounts" :key="account.id" class="oauth-account">
                <div class="account-details">
                    <div class="account-heading">
                        <strong>{{ account.email || t("oauthUnverifiedAccount") }}</strong>
                        <el-tag :type="account.identityVerified ? 'success' : 'warning'" size="small" effect="plain">
                            {{ t(account.identityVerified ? "oauthIdentityVerified" : "oauthPendingVerification") }}
                        </el-tag>
                        <el-tag v-if="hasBrowserAccount(account)" type="success" size="small" effect="plain">
                            {{ t("oauthBrowserLinked") }}
                        </el-tag>
                    </div>
                    <p v-if="account.needsOAuthClient" class="notice warning">{{ t("oauthNeedsClient") }}</p>
                    <p v-else-if="account.errorCode" class="notice warning">{{ errorMessage(account.errorCode) }}</p>
                    <p v-if="!hasBrowserAccount(account)" class="notice">{{ t("oauthBrowserLoginRequired") }}</p>
                    <p v-if="account.projectId" class="account-meta">
                        {{ t("oauthProject", { project: account.projectId }) }}
                    </p>
                    <p v-if="account.lastVerifiedAt" class="account-meta">
                        {{ t("oauthLastVerified", { time: formatTime(account.lastVerifiedAt) }) }}
                    </p>
                </div>
                <div class="account-actions">
                    <el-button
                        size="small"
                        :loading="activeId === account.id"
                        :disabled="isBusy"
                        @click="verify(account)"
                    >
                        {{ t("oauthVerify") }}
                    </el-button>
                    <a
                        v-if="!hasBrowserAccount(account)"
                        class="browser-login"
                        href="/auth"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {{ t("oauthOpenBrowserLogin") }}
                    </a>
                    <el-button
                        size="small"
                        type="danger"
                        plain
                        :disabled="isBusy || isActiveChannelAccount(account)"
                        :title="isActiveChannelAccount(account) ? t('oauthChannelActiveAccountDelete') : undefined"
                        @click="remove(account)"
                    >
                        {{ t("oauthDelete") }}
                    </el-button>
                </div>
            </li>
        </ul>

        <el-dialog
            v-model="importVisible"
            :title="t('oauthImportJson')"
            width="min(620px, calc(100vw - 32px))"
            :close-on-click-modal="!submitting"
            :close-on-press-escape="!submitting"
            :show-close="!submitting"
            :before-close="beforeClose"
            destroy-on-close
            @closed="clearImport"
        >
            <p class="import-help">{{ t("oauthImportHelp") }}</p>
            <el-input
                v-model="importText"
                type="textarea"
                :rows="8"
                :placeholder="t('oauthJsonPlaceholder')"
                :aria-label="t('oauthJsonInputLabel')"
                :disabled="submitting"
                autocomplete="off"
                autocorrect="off"
                :spellcheck="false"
                @input="clearFiles"
            />
            <div class="file-picker">
                <input
                    ref="fileInput"
                    class="hidden-input"
                    type="file"
                    accept=".json,application/json"
                    multiple
                    :disabled="submitting"
                    :aria-label="t('oauthChooseJsonFiles')"
                    @change="selectFiles"
                />
                <el-button :disabled="submitting" @click="fileInput?.click()">{{
                    t("oauthChooseJsonFiles")
                }}</el-button>
                <span v-if="fileCount">{{ t("oauthFilesSelected", { count: fileCount }) }}</span>
            </div>
            <p class="notice">{{ t("oauthImportPrivacy") }}</p>
            <p v-if="importError" class="notice error" role="alert">{{ importError }}</p>
            <div v-if="importResults.length" class="import-results" role="status">
                <p>{{ t("oauthImportSummary", { success: successCount, failed: failureCount }) }}</p>
                <p
                    v-for="(result, index) in importResults"
                    :key="index"
                    :class="['notice', result.success ? '' : 'error']"
                >
                    {{
                        t("oauthImportResultItem", {
                            index: Number.isInteger(result.index) ? result.index + 1 : index + 1,
                        })
                    }}:
                    {{ result.success ? t("oauthImportSaved") : errorMessage(result.code) }}
                </p>
            </div>
            <template #footer>
                <el-button :disabled="submitting" @click="importVisible = false">{{ t("cancel") }}</el-button>
                <el-button
                    type="primary"
                    :loading="submitting"
                    :disabled="!hasImportContent || isBusy"
                    @click="submitImport"
                >
                    {{ t("oauthImportAction") }}
                </el-button>
            </template>
        </el-dialog>
    </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import I18n from "../utils/i18n";

const props = defineProps({
    browserAccounts: { default: () => [], type: Array },
    busy: { default: false, type: Boolean },
});
const emit = defineEmits(["accounts-loaded"]);
const langVersion = ref(I18n.state.version);
const t = (key, options) => {
    langVersion.value;
    return I18n.t(key, options);
};
const oauthAccounts = ref([]);
const loading = ref(false);
const loadError = ref(false);
const activeId = ref(null);
const submitting = ref(false);
const importVisible = ref(false);
const importText = ref("");
const fileInput = ref(null);
const fileAccounts = ref([]);
const fileCount = ref(0);
const importError = ref("");
const importResults = ref([]);
const successCount = ref(0);
const failureCount = ref(0);
const channelMode = ref("build");
const channelAccountId = ref(null);
const channelProjectId = ref("");
const channelLoading = ref(false);
const channelLoaded = ref(false);
const channelSaving = ref(false);
const channelManagedByEnvironment = ref(false);
const channelError = ref("");
const savedChannel = ref({ accountId: null, mode: "build", projectId: null });
const selectedOAuthAccount = computed(() => oauthAccounts.value.find(account => account.id === channelAccountId.value));
const isBusy = computed(
    () =>
        props.busy ||
        loading.value ||
        activeId.value !== null ||
        submitting.value ||
        channelLoading.value ||
        channelSaving.value
);
const channelReadOnly = computed(() => isBusy.value || channelManagedByEnvironment.value || !channelLoaded.value);
const channelPayload = computed(() => ({
    accountId: channelMode.value === "oauth" ? channelAccountId.value : null,
    mode: channelMode.value,
    projectId: channelMode.value === "oauth" ? channelProjectId.value.trim() : null,
}));
const channelDirty = computed(() =>
    Object.keys(channelPayload.value).some(key => channelPayload.value[key] !== savedChannel.value[key])
);
const channelValid = computed(
    () =>
        channelMode.value === "build" || (Boolean(selectedOAuthAccount.value) && Boolean(channelProjectId.value.trim()))
);
const hasImportContent = computed(() => Boolean(importText.value.trim()) || fileAccounts.value.length > 0);
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const pendingRequests = new Set();
let fileReadVersion = 0;
let mounted = true;
let stopLanguageListener;

const errorKeys = {
    browser_auth_requires_browser_import: "oauthErrorBrowserJson",
    credential_identity_conflict: "oauthErrorIdentityMismatch",
    empty_import: "oauthErrorInvalidJson",
    identity_mismatch: "oauthErrorIdentityMismatch",
    identity_scope_missing: "oauthErrorIdentityScope",
    identity_unverified: "oauthErrorIdentityUnverified",
    identity_verification_failed: "oauthErrorIdentityScope",
    import_too_large: "oauthImportTooLarge",
    invalid_account: "oauthErrorInvalidJson",
    invalid_accounts_array: "oauthErrorInvalidJson",
    invalid_client: "oauthNeedsClient",
    invalid_email: "oauthErrorInvalidEmail",
    invalid_grant: "oauthErrorInvalidGrant",
    invalid_import: "oauthErrorInvalidJson",
    invalid_json: "oauthErrorInvalidJson",
    invalid_oauth_client: "oauthErrorInvalidClient",
    invalid_project_id: "oauthErrorInvalidProject",
    missing_client: "oauthNeedsClient",
    missing_oauth_client: "oauthNeedsClient",
    missing_refresh_token: "oauthErrorMissingRefreshToken",
    oauth_client_invalid: "oauthErrorInvalidClient",
    oauth_client_required: "oauthNeedsClient",
    oauth_refresh_invalid: "oauthErrorInvalidGrant",
    oauth_scope_unavailable: "oauthErrorIdentityScope",
    oauth_timeout: "oauthErrorTimeout",
    token_refresh_failed: "oauthErrorInvalidGrant",
    too_many_accounts: "oauthErrorTooManyAccounts",
    unsupported_credential_type: "oauthErrorUnsupportedType",
    unsupported_format: "oauthErrorInvalidJson",
    unsupported_google_domain: "oauthErrorUnsupportedType",
    unsupported_token_endpoint: "oauthErrorUnsupportedType",
};
const errorMessage = code => t(errorKeys[code] || "oauthOperationFailed");

const safeAccount = account => ({
    email: account.email || null,
    errorCode: account.errorCode || null,
    id: account.id,
    identityVerified: account.identityVerified === true,
    lastVerifiedAt: account.lastVerifiedAt || null,
    needsOAuthClient: account.needsOAuthClient === true,
    projectId: account.projectId || null,
});
const publishAccounts = () => emit("accounts-loaded", oauthAccounts.value.map(safeAccount));

const requestJson = async (url, options = {}) => {
    const controller = new AbortController();
    pendingRequests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        return { data: await response.json(), ok: response.ok };
    } finally {
        clearTimeout(timeout);
        pendingRequests.delete(controller);
    }
};

const oauthAccountLabel = account => {
    const name = account.email || `${t("oauthUnverifiedAccount")} #${account.id.slice(0, 8)}`;
    return account.identityVerified ? name : `${name} (${t("oauthPendingVerification")})`;
};
const isActiveChannelAccount = account =>
    savedChannel.value.mode === "oauth" && savedChannel.value.accountId === account.id;
const prefillProject = () => {
    channelProjectId.value = selectedOAuthAccount.value?.projectId || "";
};
const prepareOAuthSelection = () => {
    if (channelMode.value !== "oauth") return;
    if (!selectedOAuthAccount.value) {
        channelAccountId.value = oauthAccounts.value[0]?.id || null;
        if (!channelProjectId.value) prefillProject();
    }
};
const applyChannel = data => {
    const config = {
        accountId: data.accountId || null,
        mode: data.mode === "oauth" ? "oauth" : "build",
        projectId: data.projectId || null,
    };
    if (config.mode === "build") {
        config.accountId = null;
        config.projectId = null;
    }
    savedChannel.value = config;
    channelMode.value = config.mode;
    channelAccountId.value = config.accountId;
    channelProjectId.value = config.projectId || "";
    channelManagedByEnvironment.value = data.managedByEnvironment === true;
    channelLoaded.value = true;
};
const loadChannel = async () => {
    channelLoading.value = true;
    channelError.value = "";
    try {
        const { data, ok } = await requestJson("/api/settings/upstream-channel", { cache: "no-store" });
        if (!ok) throw new Error("request_failed");
        applyChannel(data);
    } catch {
        channelError.value = "oauthChannelLoadFailed";
    } finally {
        channelLoading.value = false;
    }
};
const saveChannel = async () => {
    channelSaving.value = true;
    channelError.value = "";
    try {
        const { data, ok } = await requestJson("/api/settings/upstream-channel", {
            body: JSON.stringify(channelPayload.value),
            headers: { "Content-Type": "application/json" },
            method: "PUT",
        });
        if (!ok) {
            channelError.value =
                data.code === "channel_managed_by_environment"
                    ? "oauthChannelManagedByEnvironment"
                    : "oauthChannelSaveFailed";
            return;
        }
        applyChannel(data);
        ElMessage.success(t("oauthChannelSaveSuccess"));
    } catch {
        channelError.value = "oauthChannelSaveFailed";
    } finally {
        channelSaving.value = false;
    }
};

const hasBrowserAccount = account =>
    account.identityVerified &&
    Boolean(account.email) &&
    props.browserAccounts.some(
        item =>
            String(item.name || "")
                .trim()
                .toLowerCase() === String(account.email).trim().toLowerCase()
    );

const formatTime = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? t("oauthTimeUnknown") : date.toLocaleString(I18n.getLang());
};

const loadAccounts = async () => {
    loading.value = true;
    loadError.value = false;
    try {
        const { data, ok } = await requestJson("/api/oauth/accounts", { cache: "no-store" });
        if (!ok) throw new Error("request_failed");
        oauthAccounts.value = Array.isArray(data.accounts) ? data.accounts.map(safeAccount) : [];
        publishAccounts();
    } catch {
        loadError.value = true;
    } finally {
        loading.value = false;
    }
};

const clearFiles = () => {
    fileReadVersion++;
    fileAccounts.value = [];
    fileCount.value = 0;
    if (fileInput.value) fileInput.value.value = "";
};

const clearImport = () => {
    importText.value = "";
    clearFiles();
    importError.value = "";
    importResults.value = [];
    successCount.value = 0;
    failureCount.value = 0;
};

const openImport = () => {
    clearImport();
    importVisible.value = true;
};
const beforeClose = done => {
    if (!submitting.value) done();
};

const unwrapAccounts = value => {
    let accounts = [value];
    if (Array.isArray(value)) accounts = value;
    else if (Array.isArray(value?.accounts)) accounts = value.accounts;
    if (!accounts.length || accounts.some(item => !item || typeof item !== "object" || Array.isArray(item))) {
        throw new Error("invalid_json");
    }
    return accounts;
};

const selectFiles = async event => {
    const files = Array.from(event.target.files || []);
    importError.value = "";
    importResults.value = [];
    if (!files.length) return;
    importText.value = "";
    clearFiles();
    const currentVersion = ++fileReadVersion;
    if (files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_BYTES) {
        clearFiles();
        importError.value = t("oauthImportTooLarge");
        return;
    }
    try {
        const accounts = [];
        for (const file of files) {
            accounts.push(...unwrapAccounts(JSON.parse(await file.text())));
            if (currentVersion !== fileReadVersion || !importVisible.value) return;
        }
        importText.value = "";
        fileAccounts.value = accounts;
        fileCount.value = files.length;
    } catch {
        if (currentVersion !== fileReadVersion || !importVisible.value) return;
        clearFiles();
        importError.value = t("oauthErrorInvalidJson");
    }
};

const submitImport = async () => {
    importError.value = "";
    importResults.value = [];
    let accounts;
    try {
        accounts = importText.value.trim() ? unwrapAccounts(JSON.parse(importText.value)) : fileAccounts.value;
        if (!accounts.length) throw new Error("invalid_json");
    } catch {
        importError.value = t("oauthErrorInvalidJson");
        return;
    }
    const body = JSON.stringify({ content: accounts });
    if (new Blob([body]).size > MAX_IMPORT_BYTES) {
        importError.value = t("oauthImportTooLarge");
        return;
    }
    submitting.value = true;
    try {
        const { data, ok } = await requestJson("/api/oauth/accounts/import", {
            body,
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        if (!ok && !Array.isArray(data.results)) {
            importError.value = errorMessage(data.code);
            return;
        }
        // Keep only result status; neither the input credentials nor an echoed account is rendered.
        importResults.value = (data.results || []).map(item => ({
            code: item.code,
            index: item.index,
            success: item.success,
        }));
        successCount.value = data.successCount || 0;
        failureCount.value = data.failureCount || 0;
        if (successCount.value) {
            importText.value = "";
            clearFiles();
            await loadAccounts();
            ElMessage.success(t("oauthImportSummary", { failed: failureCount.value, success: successCount.value }));
        }
    } catch {
        importError.value = t("oauthOperationFailed");
    } finally {
        submitting.value = false;
    }
};

const verify = async account => {
    activeId.value = account.id;
    try {
        const { data, ok } = await requestJson(`/api/oauth/accounts/${encodeURIComponent(account.id)}/verify`, {
            method: "POST",
        });
        if (data.account) {
            oauthAccounts.value = oauthAccounts.value.map(item =>
                item.id === account.id ? safeAccount(data.account) : item
            );
            publishAccounts();
        }
        if (!ok) ElMessage.warning(errorMessage(data.code));
        else ElMessage.success(t("oauthVerificationComplete"));
    } catch {
        ElMessage.error(t("oauthOperationFailed"));
    } finally {
        activeId.value = null;
    }
};

const remove = async account => {
    try {
        await ElMessageBox.confirm(t("oauthDeleteConfirm"), t("oauthDelete"), {
            cancelButtonText: t("cancel"),
            confirmButtonText: t("ok"),
            type: "warning",
        });
    } catch {
        return;
    }
    activeId.value = account.id;
    try {
        const { ok } = await requestJson(`/api/oauth/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
        if (!ok) throw new Error("request_failed");
        oauthAccounts.value = oauthAccounts.value.filter(item => item.id !== account.id);
        publishAccounts();
        ElMessage.success(t("oauthDeleteSuccess"));
    } catch {
        ElMessage.error(t("oauthOperationFailed"));
    } finally {
        activeId.value = null;
    }
};

onMounted(() => {
    stopLanguageListener = I18n.onChange(() => {
        if (mounted) langVersion.value = I18n.state.version;
    });
    Promise.allSettled([loadAccounts(), loadChannel()]);
});
onBeforeUnmount(() => {
    mounted = false;
    if (typeof stopLanguageListener === "function") stopLanguageListener();
    pendingRequests.forEach(controller => controller.abort());
    clearImport();
});
</script>

<style scoped lang="less">
.oauth-panel {
    padding-top: 18px;
    margin-top: 18px;
    border-top: 1px solid var(--border-light);
    color: var(--text-primary);
}
.channel-settings {
    padding: 12px;
    margin-top: 14px;
    border: 1px solid var(--border-light);
    border-radius: 8px;
}
.channel-heading {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    font-size: 13px;
    flex-wrap: wrap;
}
.channel-controls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
}
.channel-select {
    width: 200px;
}
.channel-account-select {
    width: 240px;
}
.channel-project-input {
    width: 240px;
}
.panel-heading,
.account-heading,
.account-actions,
.file-picker {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
}
.panel-heading {
    justify-content: space-between;
    align-items: flex-start;
    h4 {
        margin: 0 0 6px;
        font-size: 15px;
    }
    p {
        margin: 0;
        color: var(--text-secondary);
        font-size: 13px;
        line-height: 1.6;
        max-width: 700px;
    }
}
.oauth-list {
    padding: 0;
    margin: 12px 0 0;
    list-style: none;
}
.oauth-account {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    padding: 14px 0;
    border-top: 1px solid var(--border-light);
}
.account-details {
    min-width: 0;
}
.account-heading strong {
    overflow-wrap: anywhere;
    font-size: 14px;
}
.account-actions {
    align-content: flex-start;
    flex-shrink: 0;
    justify-content: flex-end;
    max-width: 50%;
}
.account-actions :deep(.el-button + .el-button) {
    margin-left: 0;
}
.notice,
.account-meta,
.import-help {
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.6;
    margin: 8px 0 0;
    overflow-wrap: anywhere;
}
.account-meta {
    font-size: 12px;
}
.notice.error {
    color: var(--color-error);
}
.notice.warning {
    color: var(--color-warning);
}
.browser-login {
    color: var(--color-primary);
    font-size: 13px;
    text-decoration: none;
    padding: 6px 0;
}
.browser-login:hover {
    text-decoration: underline;
}
.import-help {
    margin: 0 0 12px;
}
.file-picker {
    margin-top: 12px;
    color: var(--text-secondary);
    font-size: 13px;
}
.hidden-input {
    display: none;
}
.import-results {
    margin-top: 14px;
    padding-top: 8px;
    border-top: 1px solid var(--border-light);
}
@media (max-width: 700px) {
    .channel-select,
    .channel-account-select,
    .channel-project-input {
        width: 100%;
    }
    .oauth-account {
        flex-direction: column;
    }
    .account-actions {
        justify-content: flex-start;
        max-width: 100%;
    }
}
</style>
