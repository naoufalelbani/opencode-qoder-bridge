export interface QoderDeviceAccount {
    region: "global" | "cn";
    accountId: string;
    uid: string;
    access: string;
    refresh: string;
    expires: number;
    vpcEndpoint?: string;
}
export declare function saveQoderDeviceAccount(account: QoderDeviceAccount): Promise<void>;
export declare function readQoderDeviceAccount(region: "global" | "cn", accountId: string, vpcEndpoint?: string): Promise<QoderDeviceAccount | null>;
//# sourceMappingURL=device-account.d.ts.map