
/**
 * Type definitions for Claude Code Control Protocol.
 * Reverse-engineered from Vibe Kanban implementation.
 */

// Top-level message types from CLI stdout
export type CLIMessage =
    | CLIControlRequest
    | CLIControlResponse
    | CLIMessageResult
    | CLIAssistantMessage
    | CLIUserMessage
    | CLIStreamEvent;

export interface CLIControlRequest {
    type: 'control_request';
    request_id: string;
    request: ControlRequestType;
}

export interface CLIControlResponse {
    type: 'control_response';
    response: ControlResponseType;
}

export interface CLIMessageResult {
    type: 'result';
    subtype: 'success' | 'error' | string;
    result?: string;
    total_cost_usd?: number;
    duration_ms?: number;
}

export interface CLIAssistantMessage {
    type: 'assistant';
    message: {
        id: string;
        content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }>;
    };
}

export interface CLIUserMessage {
    type: 'user';
    message: {
        content: Array<{ type: 'tool_result'; tool_use_id: string; content: string }>;
    };
}

export interface CLIStreamEvent {
    type: 'stream_event';
    event: 'text_delta'; // and others?
    content: string;
}


// SDK -> CLI Requests (we send these)
export interface SDKControlRequest {
    type: 'control_request';
    request_id: string;
    request: SDKControlRequestPayload;
}

export type SDKControlRequestPayload =
    | { subtype: 'initialize'; hooks?: unknown }
    | { subtype: 'set_permission_mode'; mode: PermissionMode }
    | { subtype: 'interrupt' };

export enum PermissionMode {
    Default = 'default',
    AcceptEdits = 'acceptEdits',
    Plan = 'plan',
    BypassPermissions = 'bypassPermissions',
}

// CLI -> SDK Requests (we receive these in CLIControlRequest)
export type ControlRequestType =
    | {
        subtype: 'can_use_tool';
        tool_name: string;
        input: unknown;
        tool_use_id?: string;
        permission_suggestions?: unknown[];
    }
    | {
        subtype: 'hook_callback';
        callback_id: string;
        input: unknown;
        tool_use_id?: string;
    };

// SDK -> CLI Responses (we send these in reply to CLIControlRequest)
export interface SDKControlResponse {
    type: 'control_response';
    response: ControlResponsePayload;
}

export type ControlResponsePayload =
    | { subtype: 'success'; request_id: string; response?: unknown }
    | { subtype: 'error'; request_id: string; error?: string };


// Permission Results (sent as 'response' in Success payload for can_use_tool)
export type PermissionResult =
    | { behavior: 'allow'; updatedInput?: unknown; updatedPermissions?: unknown[] }
    | { behavior: 'deny'; message: string; interrupt?: boolean };


// Hook definitions
export interface HookConfig {
    matcher: string;
    hookCallbackIds: string[];
}

export interface ClaudeHooks {
    PreToolUse?: HookConfig[];
    PostToolUse?: HookConfig[]; // Maybe?
}
