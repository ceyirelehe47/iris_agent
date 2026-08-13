/**
 * AUTO-GENERATED runtime validators by scripts/codegen.mjs.
 * DO NOT EDIT BY HAND.
 *
 * Uses Ajv with the generated JSON Schema files.
 * Unknown schemas/fields fail closed.
 */
export declare function validate_iris_raw_archive_ref_v1(data: unknown): {
    valid: boolean;
    errors?: string[];
};
export declare function validate_iris_semantic_derivation_refs_v1(data: unknown): {
    valid: boolean;
    errors?: string[];
};
export declare function validate_iris_context_message_unit_v1(data: unknown): {
    valid: boolean;
    errors?: string[];
};
export declare function validate_iris_context_unit_source_ref_v1(data: unknown): {
    valid: boolean;
    errors?: string[];
};
export declare function validate_iris_context_unit_header_v1(data: unknown): {
    valid: boolean;
    errors?: string[];
};
export declare function validate_iris_context_unit_v2(data: unknown): {
    valid: boolean;
    errors?: string[];
};
export declare function validate_iris_context_generation_header_v1(data: unknown): {
    valid: boolean;
    errors?: string[];
};
export declare function validate_iris_context_generation_v2(data: unknown): {
    valid: boolean;
    errors?: string[];
};
export declare function validateSemantic_iris_semantic_context_message_user_v1(data: unknown): {
    valid: boolean;
    errors?: string[];
};
export declare function validateSemantic_iris_semantic_context_message_assistant_v1(data: unknown): {
    valid: boolean;
    errors?: string[];
};
export declare function validateSemantic_iris_semantic_context_message_tool_call_v1(data: unknown): {
    valid: boolean;
    errors?: string[];
};
export declare function validateSemantic_iris_semantic_context_message_tool_result_v1(data: unknown): {
    valid: boolean;
    errors?: string[];
};
export declare function validateSemantic_iris_semantic_context_message_body_event_v1(data: unknown): {
    valid: boolean;
    errors?: string[];
};
export declare function validateSemantic_iris_semantic_context_message_operational_v1(data: unknown): {
    valid: boolean;
    errors?: string[];
};
export declare function validateSemanticContent(semanticSchemaId: string, content: unknown): {
    valid: boolean;
    errors?: string[];
};
export declare function isKnownSemanticSchemaId(id: string): boolean;
