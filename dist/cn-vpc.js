const VPC_DOMAIN = "vpc.qoder.com.cn";
/** Normalize a CN enterprise instance name/address to the SDK gateway host. */
export function normalizeCnVpcEndpoint(input) {
    if (typeof input !== "string")
        return undefined;
    const value = input.trim();
    if (!value || value.length > 512)
        return undefined;
    let instance = value;
    if (value.includes("://")) {
        try {
            const url = new URL(value);
            if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/")
                return undefined;
            instance = url.hostname.toLowerCase();
        }
        catch {
            return undefined;
        }
    }
    else if (value.includes("/") || value.includes("?") || value.includes("#") || value.includes(":")) {
        return undefined;
    }
    const suffix = `.${VPC_DOMAIN}`;
    if (instance.toLowerCase().endsWith(suffix))
        instance = instance.slice(0, -suffix.length);
    instance = instance.toLowerCase().replace(/-(?:openapi|gateway)$/i, "");
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(instance) || instance.length > 63)
        return undefined;
    return `${instance}-gateway.${VPC_DOMAIN}`;
}
export function cnVpcOpenApiEndpoint(gatewayEndpoint) {
    return gatewayEndpoint.replace(/-gateway\./, "-openapi.");
}
//# sourceMappingURL=cn-vpc.js.map