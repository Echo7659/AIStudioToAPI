function parseBrowserAuth(content) {
    let data;
    try {
        data = typeof content === "string" ? JSON.parse(content) : content;
    } catch {
        throw new Error("Invalid browser authentication JSON");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Browser authentication must be a JSON object");
    }
    if (data.refresh_token || data.token?.refresh_token) {
        throw new Error("Use OAuth JSON import for refresh_token credentials");
    }
    if (!Array.isArray(data.cookies) || data.cookies.length === 0) {
        throw new Error("Browser authentication requires non-empty Playwright cookies");
    }
    const cookiesValid = data.cookies.every(
        cookie =>
            cookie &&
            typeof cookie === "object" &&
            typeof cookie.name === "string" &&
            cookie.name.length > 0 &&
            typeof cookie.value === "string" &&
            typeof cookie.domain === "string" &&
            cookie.domain.length > 0 &&
            typeof cookie.path === "string" &&
            cookie.path.startsWith("/") &&
            Number.isFinite(cookie.expires) &&
            typeof cookie.httpOnly === "boolean" &&
            typeof cookie.secure === "boolean" &&
            ["Strict", "Lax", "None"].includes(cookie.sameSite)
    );
    if (!cookiesValid) throw new Error("Invalid Playwright cookie fields");
    const origins = data.origins ?? [];
    if (
        !Array.isArray(origins) ||
        !origins.every(origin => {
            if (!origin || typeof origin.origin !== "string" || !Array.isArray(origin.localStorage)) return false;
            try {
                const url = new URL(origin.origin);
                if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin.origin) return false;
            } catch {
                return false;
            }
            return origin.localStorage.every(
                item => item && typeof item.name === "string" && typeof item.value === "string"
            );
        })
    )
        throw new Error("Invalid Playwright origin fields");
    return { ...data, cookies: data.cookies, origins };
}

module.exports = { parseBrowserAuth };
