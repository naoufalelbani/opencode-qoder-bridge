type PromptMessage = {
    role: string;
    content: unknown;
};
type TextBlock = {
    type: "text";
    text: string;
};
type ImageBlock = {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
};
export type SdkUserMessage = {
    type: "user";
    session_id: string;
    parent_tool_use_id: null;
    message: {
        role: "user";
        content: Array<TextBlock | ImageBlock>;
    };
};
export declare function promptHasImage(prompt: PromptMessage[]): boolean;
export declare function buildPromptString(prompt: PromptMessage[], contextWindow: number): string;
export declare function buildPromptIterable(prompt: PromptMessage[], contextWindow: number, sessionId: string): AsyncGenerator<SdkUserMessage>;
export {};
//# sourceMappingURL=prompt-builder.d.ts.map