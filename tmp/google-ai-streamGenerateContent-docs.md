# Google AI Gemini API - StreamGenerateContent 方法文档

## 概述

`streamGenerateContent` 方法从给定的 `GenerateContentRequest` 输入生成模型的流式响应。

## 端点信息

**HTTP方法**: `POST`
**URL**: `https://generativelanguage.googleapis.com/v1beta/{model=models/*}:streamGenerateContent`

### 路径参数

| 参数 | 类型 | 描述 |
|------|------|------|
| `model` | string | 必需。要用于生成的模型名称。格式：`models/{model}` |

## 请求结构

### 请求体字段

| 字段名 | 类型 | 是否必需 | 描述 |
|--------|------|----------|------|
| `contents[]` | object (Content) | 必需 | 与模型的当前对话内容。对于单轮查询，这是单个实例。对于多轮查询（如聊天），这是包含对话历史和最新请求的重复字段。 |
| `tools[]` | object (Tool) | 可选 | 模型可用于生成下一个响应的工具列表。支持的工具包括 Function 和 codeExecution。 |
| `toolConfig` | object (ToolConfig) | 可选 | 请求中指定的任何工具的工具配置。 |
| `safetySettings[]` | object (SafetySetting) | 可选 | 用于阻止不安全内容的唯一 SafetySetting 实例列表。支持的危害类别包括：HARM_CATEGORY_HATE_SPEECH, HARM_CATEGORY_SEXUALLY_EXPLICIT, HARM_CATEGORY_DANGEROUS_CONTENT, HARM_CATEGORY_HARASSMENT, HARM_CATEGORY_CIVIC_INTEGRITY。 |
| `systemInstruction` | object (Content) | 可选 | 开发者设置的系统指令。当前仅支持文本。 |
| `generationConfig` | object (GenerationConfig) | 可选 | 模型生成和输出的配置选项。 |
| `cachedContent` | string | 可选 | 用作预测上下文的缓存内容名称。格式：`cachedContents/{cachedContent}` |

### 请求体JSON结构

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "string"
        }
      ]
    }
  ],
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "string",
          "description": "string",
          "parameters": {
            "type": "object",
            "properties": {}
          }
        }
      ]
    }
  ],
  "toolConfig": {
    "functionCallingConfig": {
      "mode": "enum",
      "allowedFunctionNames": ["string"]
    }
  },
  "safetySettings": [
    {
      "category": "enum",
      "threshold": "enum"
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "string"
      }
    ]
  },
  "generationConfig": {
    "stopSequences": ["string"],
    "responseMimeType": "string",
    "responseSchema": {},
    "candidateCount": "integer",
    "maxOutputTokens": "integer",
    "temperature": "number",
    "topP": "number",
    "topK": "integer",
    "presencePenalty": "number",
    "frequencyPenalty": "number",
    "responseLogprobs": "boolean",
    "logprobs": "integer"
  },
  "cachedContent": "string"
}
```

## 响应结构

### 响应体

成功时，响应体包含 `GenerateContentResponse` 实例的流。

### GenerateContentResponse JSON结构

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "string"
          }
        ],
        "role": "string"
      },
      "finishReason": "enum (FinishReason)",
      "safetyRatings": [
        {
          "category": "enum",
          "probability": "enum",
          "blocked": "boolean"
        }
      ],
      "citationMetadata": {
        "citationSources": [
          {
            "startIndex": "integer",
            "endIndex": "integer",
            "uri": "string",
            "license": "string"
          }
        ]
      },
      "tokenCount": "integer",
      "groundingAttributions": [
        {
          "sourceId": {
            "groundingPassage": {
              "passageId": "string"
            },
            "semanticRetrieverChunk": {
              "source": "string",
              "chunk": "string"
            }
          },
          "content": {
            "parts": [
              {
                "text": "string"
              }
            ]
          }
        }
      ],
      "groundingMetadata": {
        "searchEntryPoint": {
          "renderedContent": "string"
        },
        "groundingChunks": [
          {
            "web": {
              "uri": "string",
              "title": "string"
            }
          }
        ],
        "groundingSupports": [
          {
            "segment": {
              "startIndex": "integer",
              "endIndex": "integer",
              "text": "string"
            },
            "groundingChunkIndices": ["integer"],
            "confidenceScores": ["number"]
          }
        ],
        "retrievalMetadata": {
          "googleSearchDynamicRetrievalScore": "number"
        }
      },
      "logprobsResult": {
        "topCandidates": [
          {
            "candidates": [
              {
                "token": "string",
                "tokenId": "integer",
                "logProbability": "number"
              }
            ]
          }
        ],
        "chosenCandidates": [
          {
            "token": "string",
            "tokenId": "integer",
            "logProbability": "number"
          }
        ]
      }
    }
  ],
  "promptFeedback": {
    "blockReason": "enum (BlockReason)",
    "safetyRatings": [
      {
        "category": "enum",
        "probability": "enum",
        "blocked": "boolean"
      }
    ]
  },
  "usageMetadata": {
    "promptTokenCount": "integer",
    "cachedContentTokenCount": "integer",
    "candidatesTokenCount": "integer",
    "toolUsePromptTokenCount": "integer",
    "thoughtsTokenCount": "integer",
    "totalTokenCount": "integer",
    "promptTokensDetails": [
      {
        "modality": "enum",
        "tokenCount": "integer"
      }
    ],
    "cacheTokensDetails": [
      {
        "modality": "enum",
        "tokenCount": "integer"
      }
    ]
  },
  "modelVersion": "string",
  "responseId": "string"
}
```

## 请求示例

### 基本文本生成（流式）

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}" \
  -H 'Content-Type: application/json' \
  --no-buffer \
  -d '{
    "contents": [{
      "parts": [{
        "text": "Write a story about a magic backpack."
      }]
    }]
  }'
```

### 多模态请求（图像）

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=$GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{
    "contents": [{
      "parts":[
        {"text": "Please describe this image."},
        {"inline_data":{"mime_type": "image/jpeg", "data": "base64_image_data"}}
      ]
    }]
  }'
```

### 聊天对话

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=$GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{
    "contents": [
      {
        "role":"user",
        "parts":[{
          "text": "Hello"
        }]
      },
      {
        "role": "model",
        "parts":[{
          "text": "Great to meet you. What would you like to know?"
        }]
      },
      {
        "role":"user",
        "parts":[{
          "text": "I have 2 dogs in my house. How many paws are in my house?"
        }]
      }
    ]
  }'
```

### 带生成配置的请求

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=$GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{
    "contents": [{
      "parts":[{
        "text": "Explain how AI works"
      }]
    }],
    "generationConfig": {
      "stopSequences": ["Title"],
      "temperature": 1.0,
      "maxOutputTokens": 800,
      "topP": 0.8,
      "topK": 10
    }
  }'
```

### JSON模式输出

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=$GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{
    "contents": [{
      "parts":[{
        "text": "List 5 popular cookie recipes"
      }]
    }],
    "generationConfig": {
      "response_mime_type": "application/json",
      "response_schema": {
        "type": "ARRAY",
        "items": {
          "type": "OBJECT",
          "properties": {
            "recipe_name": {"type":"STRING"}
          }
        }
      }
    }
  }'
```

## 关键特性

1. **流式响应**: 使用 `alt=sse` 参数启用Server-Sent Events格式的流式响应
2. **多模态支持**: 支持文本、图像、音频、视频和PDF文件
3. **对话历史**: 支持多轮对话，包含完整的对话上下文
4. **工具调用**: 支持函数调用和代码执行工具
5. **安全设置**: 内置内容安全过滤和评级
6. **生成配置**: 灵活的生成参数控制（温度、令牌数量、停止序列等）
7. **缓存支持**: 支持使用预缓存的内容以提高性能

## 认证与授权

### API密钥认证

API使用API密钥进行认证。你可以通过以下方式获取API密钥：

- 访问 [AI Studio](https://aistudio.google.com/apikey) 获取免费API密钥
- 在请求URL中添加 `?key=YOUR_API_KEY` 参数
- 或在请求头中设置 `Authorization: Bearer YOUR_API_KEY`

### 使用示例

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?key=$GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"contents": [{"parts": [{"text": "Hello"}]}]}'
```

### 在代码中使用

```javascript
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
```

```python
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
```

```go
client, err := genai.NewClient(ctx, &genai.ClientConfig{
    APIKey: os.Getenv("GEMINI_API_KEY"),
})
```

## 高级功能示例

### 音频处理示例

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=$GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{
    "contents": [{
      "parts": [
        {"text": "Summarize this audio file"},
        {"file_data": {"mime_type": "audio/mp3", "file_uri": "gs://your-bucket/audio.mp3"}}
      ]
    }]
  }'
```

### 视频处理示例

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=$GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{
    "contents": [{
      "parts": [
        {"text": "Describe what happens in this video"},
        {"file_data": {"mime_type": "video/mp4", "file_uri": "gs://your-bucket/video.mp4"}}
      ]
    }]
  }'
```

### PDF文档分析示例

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=$GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{
    "contents": [{
      "parts": [
        {"text": "Summarize the key points from this PDF"},
        {"file_data": {"mime_type": "application/pdf", "file_uri": "gs://your-bucket/document.pdf"}}
      ]
    }]
  }'
```

### 代码执行工具示例

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=$GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{
    "contents": [{
      "parts": [{"text": "Calculate the fibonacci sequence for n=10 and plot it"}]
    }],
    "tools": [{
      "code_execution": {}
    }]
  }'
```

### 缓存内容使用示例

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=$GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{
    "contents": [{
      "parts": [{"text": "Based on the cached document, what are the main conclusions?"}]
    }],
    "cachedContent": "cachedContents/cached-content-id"
  }'
```

### 调优模型使用示例

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/tunedModels/your-tuned-model:streamGenerateContent?alt=sse&key=$GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{
    "contents": [{
      "parts": [{"text": "Generate content using my tuned model"}]
    }]
  }'
```