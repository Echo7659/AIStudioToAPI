const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

class ChannelConfigError extends Error {
    constructor(code, statusCode = 400) {
        super(code);
        this.code = code;
        this.statusCode = statusCode;
    }
}

function validate(input) {
    if (!input || !["build", "oauth"].includes(input.mode)) throw new ChannelConfigError("invalid_channel");
    if (input.mode === "build") return { accountId: null, mode: "build", projectId: null };
    if (typeof input.accountId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(input.accountId)) {
        throw new ChannelConfigError("oauth_account_required");
    }
    if (typeof input.projectId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,149}$/.test(input.projectId)) {
        throw new ChannelConfigError("cloud_project_required");
    }
    return { accountId: input.accountId, mode: "oauth", projectId: input.projectId };
}

class UpstreamChannelStore {
    constructor(options = {}) {
        this.filePath = options.filePath || path.join(process.cwd(), "data", "upstream-channel.json");
        this.env = options.env || process.env;
        this.queue = Promise.resolve();
    }

    async get() {
        if (this.env.API_UPSTREAM_CHANNEL) {
            return {
                ...validate({
                    accountId: this.env.GOOGLE_OAUTH_ACCOUNT_ID || null,
                    mode: this.env.API_UPSTREAM_CHANNEL,
                    projectId: this.env.GOOGLE_OAUTH_PROJECT_ID || null,
                }),
                managedByEnvironment: true,
            };
        }
        try {
            return { ...validate(JSON.parse(await fs.readFile(this.filePath, "utf8"))), managedByEnvironment: false };
        } catch (error) {
            if (error.code === "ENOENT")
                return { accountId: null, managedByEnvironment: false, mode: "build", projectId: null };
            throw new ChannelConfigError("channel_config_unavailable", 503);
        }
    }

    async set(input, accounts) {
        const operation = this.queue.then(async () => {
            if (this.env.API_UPSTREAM_CHANNEL) throw new ChannelConfigError("channel_managed_by_environment", 409);
            const config = validate(input);
            if (config.mode === "oauth" && !accounts.some(account => account.id === config.accountId)) {
                throw new ChannelConfigError("oauth_account_not_found", 404);
            }
            const directory = path.dirname(this.filePath);
            await fs.mkdir(directory, { recursive: true });
            const temporary = path.join(directory, `.channel-${crypto.randomUUID()}.tmp`);
            try {
                await fs.writeFile(temporary, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 });
                await fs.rename(temporary, this.filePath);
            } finally {
                await fs.unlink(temporary).catch(() => {});
            }
            return { ...config, managedByEnvironment: false };
        });
        this.queue = operation.catch(() => {});
        return operation;
    }
}

module.exports = UpstreamChannelStore;
module.exports.ChannelConfigError = ChannelConfigError;
