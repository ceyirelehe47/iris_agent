#!/usr/bin/env python3
"""Update semanticSchemas in contracts/source/schemas.json to concrete shapes.

Round 7 (#123): no generic {} / open additionalProperties escape. Every
semantic payload schema has typed required fields, nested shapes, enums and
additionalProperties:false. Shapes mirror the Pi message types that Iris
ingests (UserMessage/AssistantMessage/ToolResultMessage) plus Iris-native
tool_call/body_event/operational payloads.
"""
import json

PATH = "contracts/source/schemas.json"
d = json.load(open(PATH))

FORBIDDEN = [
    "contextUnitId", "contextLineageId", "contextSeq", "runtimeEventId",
    "semanticSchemaId", "contentHash", "lifecycleState", "historianDisposition",
    "layer", "pLevel", "sourceKind",
]

TEXT_PART = {
    "type": "object",
    "properties": {"type": {"const": "text"}, "text": {"type": "string"}},
    "required": ["type", "text"],
    "additionalProperties": False,
}
IMAGE_PART = {
    "type": "object",
    "properties": {
        "type": {"const": "image"},
        "data": {"type": "string"},
        "mimeType": {"type": "string"},
    },
    "required": ["type", "data", "mimeType"],
    "additionalProperties": False,
}
TOOL_CALL_PART = {
    "type": "object",
    "properties": {
        "type": {"const": "toolCall"},
        "id": {"type": "string", "minLength": 1},
        "name": {"type": "string", "minLength": 1},
        "arguments": {"type": "object"},
        "thoughtSignature": {"type": "string"},
    },
    "required": ["type", "id", "name", "arguments"],
    "additionalProperties": False,
}
THINKING_PART = {
    "type": "object",
    "properties": {
        "type": {"const": "thinking"},
        "text": {"type": "string"},
        "signature": {"type": "string"},
        "redacted": {"type": "boolean"},
    },
    "required": ["type", "text"],
    "additionalProperties": False,
}
CONTENT_PART = {
    "oneOf": [TEXT_PART, IMAGE_PART, TOOL_CALL_PART, THINKING_PART],
}
CONTENT_OR_STRING = {
    "oneOf": [{"type": "string"}, {"type": "array", "items": CONTENT_PART}],
}
USAGE = {
    "type": "object",
    "properties": {
        "input": {"type": "number"},
        "output": {"type": "number"},
        "cacheRead": {"type": "number"},
        "cacheWrite": {"type": "number"},
        "cacheWrite1h": {"type": "number"},
        "reasoning": {"type": "number"},
        "totalTokens": {"type": "number"},
        "cost": {
            "type": "object",
            "properties": {
                "input": {"type": "number"},
                "output": {"type": "number"},
                "cacheRead": {"type": "number"},
                "cacheWrite": {"type": "number"},
                "total": {"type": "number"},
            },
            "required": ["input", "output", "cacheRead", "cacheWrite", "total"],
            "additionalProperties": False,
        },
    },
    "required": ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"],
    "additionalProperties": False,
}

semantic = {
    "iris.semantic.context_message.user.v1": {
        "forbiddenPayloadFields": FORBIDDEN,
        "schema": {
            "type": "object",
            "properties": {
                "role": {"type": "string", "enum": ["user", "custom"]},
                "content": CONTENT_OR_STRING,
                "timestamp": {"type": "number"},
            },
            "required": ["role", "content"],
            "additionalProperties": False,
        },
    },
    "iris.semantic.context_message.assistant.v1": {
        "forbiddenPayloadFields": FORBIDDEN,
        "schema": {
            "type": "object",
            "properties": {
                "role": {"const": "assistant"},
                "content": CONTENT_OR_STRING,
                "api": {"type": "string", "minLength": 1},
                "provider": {"type": "string", "minLength": 1},
                "model": {"type": "string", "minLength": 1},
                "responseModel": {"type": "string"},
                "responseId": {"type": "string"},
                "diagnostics": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": {"type": "string"},
                            "message": {"type": "string"},
                        },
                        "required": ["type", "message"],
                        "additionalProperties": False,
                    },
                },
                "usage": USAGE,
                "stopReason": {
                    "type": "string",
                    "enum": ["pending", "stop", "length", "toolUse", "error", "aborted"],
                },
                "errorMessage": {"type": "string"},
                "rawStopReason": {"type": "string"},
                "timestamp": {"type": "number"},
            },
            "required": ["role", "content", "timestamp"],
            "additionalProperties": False,
        },
    },
    "iris.semantic.context_message.tool_call.v1": {
        "forbiddenPayloadFields": FORBIDDEN,
        "schema": {
            "type": "object",
            "properties": {
                "role": {"const": "assistant"},
                "content": {"type": "array", "items": CONTENT_PART},
                "toolCalls": {
                    "type": "array",
                    "items": TOOL_CALL_PART,
                },
                "timestamp": {"type": "number"},
            },
            "required": ["role", "content"],
            "additionalProperties": False,
        },
    },
    "iris.semantic.context_message.tool_result.v1": {
        "forbiddenPayloadFields": FORBIDDEN,
        "schema": {
            "type": "object",
            "properties": {
                "role": {"const": "toolResult"},
                "toolCallId": {"type": "string", "minLength": 1},
                "toolName": {"type": "string", "minLength": 1},
                "content": {
                    "type": "array",
                    "items": {
                        "oneOf": [
                            TEXT_PART,
                            IMAGE_PART,
                            {
                                "type": "object",
                                "properties": {
                                    "type": {"const": "reasoning"},
                                    "text": {"type": "string"},
                                },
                                "required": ["type", "text"],
                                "additionalProperties": False,
                            },
                        ]
                    },
                },
                "details": {},
                "usage": USAGE,
                "addedToolNames": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "isError": {"type": "boolean"},
                "timestamp": {"type": "number"},
            },
            "required": ["role", "toolCallId", "toolName", "content", "isError", "timestamp"],
            "additionalProperties": False,
        },
    },
    "iris.semantic.context_message.body_event.v1": {
        "forbiddenPayloadFields": FORBIDDEN,
        "schema": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "minLength": 1},
                "data": {"type": "object"},
                "payload": {"type": "object"},
                "timestamp": {"type": "number"},
            },
            "required": ["type"],
            "additionalProperties": False,
        },
    },
    "iris.semantic.context_message.operational.v1": {
        "forbiddenPayloadFields": FORBIDDEN,
        "schema": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "minLength": 1},
                "data": {"type": "object"},
                "timestamp": {"type": "number"},
            },
            "required": ["type"],
            "additionalProperties": False,
        },
    },
}

d["semanticSchemas"] = semantic
json.dump(d, open(PATH, "w"), indent=2, ensure_ascii=False)
print("semanticSchemas updated")
