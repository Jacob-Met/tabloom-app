// Frozen receipt model contract, received against real photos. Never selects a model implicitly.
export const RECEIPT_VISION_MANIFEST = {
  "schema": "tabloom.local_language_reference.v1",
  "purpose": "Bounded receipt recognition proof using maintained ReferenceSession and estate-pinned smaller model; not production adoption.",
  "model": {
    "repository": "bartowski/Qwen_Qwen3.5-4B-GGUF",
    "revision": "4168f45a16a1290d65a4ec0fa312ae917a4c15d6",
    "file": "Qwen_Qwen3.5-4B-Q4_K_M.gguf",
    "bytes": 3013027808,
    "sha256": "13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983",
    "quantization": "Q4_K_M",
    "license": "Apache-2.0",
    "license_sha256": "bbedc3fda3305820b977265f01b8619d87570a6739de3a5582c3464840f1e57a",
    "license_source": {
      "repository": "Qwen/Qwen3.5-4B",
      "revision": "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"
    },
    "original_tensor_repository": "Qwen/Qwen3.5-4B",
    "original_tensor_revision": "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"
  },
  "runtime": {
    "repository": "ggml-org/llama.cpp",
    "release": "v0.7.0",
    "binary_tag": "b11669",
    "commit": "620d2225cc436ab0b001e3200e590e3b286ef9ab",
    "file": "llama-b11669-bin-ubuntu-x64.tar.gz",
    "bytes": 17851611,
    "sha256": "cf07c1c112d709bd67e522017471de57ed0ec8bea031d732c5422351c07f65ac",
    "license": "MIT"
  },
  "initial_serving_configuration": {
    "host": "127.0.0.1",
    "threads": 4,
    "threads_batch": 4,
    "parallel": 1,
    "gpu_layers": 0,
    "context_tokens": 4096,
    "batch_tokens": 128,
    "microbatch_tokens": 128,
    "max_new_tokens": 512,
    "thinking": false,
    "temperature": 0.7,
    "top_p": 0.8,
    "top_k": 20,
    "min_p": 0,
    "presence_penalty": 1.5,
    "seed": 2601026,
    "image_min_tokens": 1024,
    "image_max_tokens": 1024,
    "status": "Frozen receipt proof: existing estate-pinned 4B weights plus same-revision F16 projector; actual compatibility, memory and accuracy remain to be received."
  },
  "projector": {
    "repository": "bartowski/Qwen_Qwen3.5-4B-GGUF",
    "revision": "4168f45a16a1290d65a4ec0fa312ae917a4c15d6",
    "file": "mmproj-Qwen_Qwen3.5-4B-f16.gguf",
    "bytes": 672423488,
    "sha256": "659b59dd44b73b1cd34af6cc424669484b06dc80f4340adf8ea84ad776eef813"
  }
} as const;
export const RECEIPT_VISION_CONFIG = {
  "host": "127.0.0.1",
  "threads": 4,
  "threads_batch": 4,
  "parallel": 1,
  "gpu_layers": 0,
  "context_tokens": 4096,
  "batch_tokens": 128,
  "microbatch_tokens": 128,
  "max_new_tokens": 512,
  "thinking": false,
  "temperature": 0.7,
  "top_p": 0.8,
  "top_k": 20,
  "min_p": 0,
  "presence_penalty": 1.5,
  "seed": 2601026,
  "image_min_tokens": 512,
  "image_max_tokens": 512,
  "status": "Frozen receipt proof: existing estate-pinned 4B weights plus same-revision F16 projector; actual compatibility, memory and accuracy remain to be received.",
  "speculative_type": "draft-mtp",
  "speculative_draft_max": 3
} as const;
// Versioned model transport; the app expands it into the existing named review fields.
// The pinned runtime supports legacy tuple items arrays, with natural JSON whitespace.
export const RECEIPT_VISION_FORMAT = {
  "type": "json_object",
  "schema": {
    "type": "object",
    "properties": {
      "v": {
        "type": "integer",
        "const": 1
      },
      "items": {
        "type": "array",
        "items": {
          "type": "array",
          "items": [
            {
              "type": "string"
            },
            {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            }
          ],
          "minItems": 2,
          "maxItems": 2,
          "additionalItems": false
        },
        "maxItems": 100
      },
      "printed": {
        "type": "array",
        "items": [
          {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          }
        ],
        "minItems": 5,
        "maxItems": 5,
        "additionalItems": false
      }
    },
    "required": [
      "v",
      "items",
      "printed"
    ],
    "additionalProperties": false
  }
};
export const RECEIPT_VISION_PROMPT = "Transcribe the printed receipt in this image faithfully. Include each charged item name and its printed line price. Do not calculate or infer missing amounts. Preserve decimal digits exactly. Mark an unreadable name or amount as [unreadable]. Exclude payment tender, change, card balance and suggested tip examples from charged items. Return only JSON with v equal to 1. items contains [printed item name, printed line price] pairs in receipt order, including repeated rows. printed contains exactly five values in this order: subtotal, tax, tip, discount, total. Every amount is its printed string or null if absent. Keep all five positions, including nulls. Do not explain.";
