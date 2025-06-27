import {
  generateText,
  LanguageModelV1,
  streamText,
  CoreMessage,
  generateObject,
  tool,
  Tool,
  ToolSet,
  Output,
  TextPart,
  ImagePart,
  FilePart,
  EmbeddingModel,
  cosineSimilarity,
  embed,
  embedMany,
  Embedding,
} from "npm:ai";
import { google } from "npm:@ai-sdk/google";
import { xai } from "npm:@ai-sdk/xai";
import { openai } from "npm:@ai-sdk/openai";
import fs from "node:fs/promises";
import { z } from "npm:zod";
import { Buffer } from "node:buffer";
import { createOpenAICompatible } from "npm:@ai-sdk/openai-compatible";

const checkEnv = (key: string) => {
  if (!Deno.env.get(key)) {
    throw new Error(`${key} is not set`);
  }
};

export const embeddingModels = {
  get_lmstudio: (modelName: string) => {
    const model = createOpenAICompatible({
      name: "lmstudio",
      baseURL: `http://localhost:1234/v1`,
      apiKey: "1234567890",
    });
    return {
      model: model.textEmbeddingModel(modelName),
      modelOptions: {
        maxRetries: 0,
      },
    };
  },
};

export const models = {
  get_openai: () => {
    checkEnv("OPENAI_API_KEY");
    return openai("gpt-4o-mini");
  },
  get_lmstudio: (modelName: string = "qwen/qwen3-1.7b") => {
    const model = createOpenAICompatible({
      name: "lmstudio",
      baseURL: `http://localhost:1234/v1`,
      apiKey: "1234567890",
    });
    return {
      model: model(modelName),
      modelOptions: {
        maxRetries: 0,
      },
    };
  },
  get_google: (
    modelType:
      | "gemini-2.5-flash-preview-04-17"
      | "gemini-2.5-flash-lite-preview-06-17"
      | "gemma-3n-e4b-it"
      | "gemma-3-27b-it"
      | "gemma-3-12b-it" = "gemini-2.5-flash-preview-04-17"
  ) => {
    checkEnv("GOOGLE_GENERATIVE_AI_API_KEY");
    // console.log("Tool calling does not work with Google models");
    return google(modelType);
  },
  get_xai: () => {
    checkEnv("XAI_API_KEY");
    return xai("grok-3-beta");
  },
};

interface VercelAIOptions {
  maxRetries?: number;
  noThink?: boolean;
  hideThinking?: boolean;
}

function transformResponse(response: string, options: VercelAIOptions) {
  if (options.hideThinking) {
    return response.replace("<think>", "").replace("</think>", "");
  }
  return response;
}

export class VercelAIEmbedding {
  constructor(
    public readonly model: EmbeddingModel<string>,
    private modelOptions?: VercelAIOptions
  ) {}

  async embedOne(text: string) {
    const response = await embed({
      model: this.model,
      value: text,
      maxRetries: this.modelOptions?.maxRetries,
    });
    return response.embedding;
  }

  async embedMany(texts: string[]) {
    const response = await embedMany({
      model: this.model,
      values: texts,
      maxRetries: this.modelOptions?.maxRetries,
    });
    return {
      embeddings: response.embeddings,
      createVectorStore: () => {
        const vectorDatabase = response.embeddings.map((embedding, index) => ({
          value: texts[index],
          embedding,
        }));
        return vectorDatabase;
      },
    };
  }

  async getNearestNeighbors(
    text: string,
    k: number,
    vectorDatabase: {
      value: string;
      embedding: Embedding;
    }[]
  ) {
    const response = await this.embedOne(text);
    const entries = vectorDatabase
      .map((entry) => {
        return {
          value: entry.value,
          similarity: cosineSimilarity(entry.embedding, response),
        };
      })
      .sort((a, b) => b.similarity - a.similarity);
    return entries.slice(0, Math.min(k, entries.length));
  }
}

export class VercelAI {
  constructor(
    public readonly model: LanguageModelV1,
    private modelOptions?: VercelAIOptions
  ) {}

  async generateText(prompt: string, systemPrompt?: string) {
    const response = await generateText({
      model: this.model,
      prompt,
      system: systemPrompt,
      maxRetries: this.modelOptions?.maxRetries,
    });
    return this.modelOptions
      ? transformResponse(response.text, this.modelOptions)
      : response.text;
  }

  async callWithTools({
    prompt,
    systemPrompt,
    tools,
  }: {
    prompt: string;
    systemPrompt?: string;
    tools: ToolSet;
  }) {
    const { text, toolCalls, toolResults, steps } = await generateText({
      model: this.model,
      prompt,
      system: systemPrompt,
      tools,
      toolChoice: "auto",
      maxSteps: 3,
      maxRetries: this.modelOptions?.maxRetries,
    });
    if (toolCalls.length > 0) {
      console.log("tools called");
      const lastToolResult = steps.at(-1);
      if (!lastToolResult) {
        return { text };
      }
      const { toolResults: results } = lastToolResult;
      return {
        text,
        finalToolResult: (results.at(-1) as unknown as any)?.result,
        toolCalls,
        toolResults,
      };
    }
    return { text };
  }

  generateTextStream(prompt: string) {
    const { textStream } = streamText({
      model: this.model,
      prompt,
      maxRetries: this.modelOptions?.maxRetries,
    });
    return textStream;
  }

  async getJSONFromPrompt<T extends z.ZodSchema>({
    systemPrompt,
    prompt,
    schema,
  }: {
    systemPrompt?: string;
    prompt: string;
    schema: T;
  }) {
    const response = await generateObject({
      model: this.model,
      system: systemPrompt,
      prompt,
      schema,
      maxRetries: this.modelOptions?.maxRetries,
    });
    return response.object as z.infer<T>;
  }

  async getClassificationFromPrompt<T extends any[]>({
    systemPrompt,
    prompt,
    enumValues,
  }: {
    systemPrompt?: string;
    prompt: string;
    enumValues: T;
  }) {
    const response = await generateObject({
      model: this.model,
      system: systemPrompt,
      prompt,
      enum: enumValues,
      output: "enum",
      maxRetries: this.modelOptions?.maxRetries,
    });
    return response.object as T[number];
  }
}

export class VercelAIChat {
  constructor(
    public readonly model: LanguageModelV1,
    private messages: CoreMessage[] = [],
    private modelOptions?: VercelAIOptions
  ) {}

  addSystemMessage(message: string) {
    this.messages.push({
      role: "system",
      content: message,
    });
  }

  loadChat(content: string) {
    try {
      const data = JSON.parse(content);
      this.messages = data.map((m: any) => ({
        role: m.role,
        content: m.content,
      }));
    } catch (error) {
      throw new Error("Invalid chat format");
    }
  }

  async chat(message: string) {
    this.messages.push({
      role: "user",
      content: message,
    });
    const response = await generateText({
      model: this.model,
      messages: this.messages,
    });
    this.messages.push({
      role: "assistant",
      content: response.text,
    });
    return response.text;
  }

  async chatWithMessage(message: CoreMessage) {
    this.messages.push(message);
    const response = await generateText({
      model: this.model,
      messages: this.messages,
    });
    this.messages.push({
      role: "assistant",
      content: response.text,
    });
    return response.text;
  }

  async chatWithTools(
    message: string,
    tools: ToolSet
  ): Promise<{ text: string; toolResult?: any | undefined }> {
    this.messages.push({
      role: "user",
      content: message,
    });
    const { text, toolCalls, steps } = await generateText({
      model: this.model,
      messages: this.messages,
      tools,
      maxSteps: 3,
    });
    // tool was called
    if (toolCalls.length > 0) {
      const lastToolResult = steps.at(-1);
      if (!lastToolResult) {
        return { text };
      }
      const { text: stepText, toolCalls, toolResults } = lastToolResult;
      this.messages.push({
        role: "assistant",
        content: stepText,
      });
      return {
        text: stepText,
        toolResult: (toolResults.at(-1) as unknown as any)?.result,
      };
    }

    return { text };
  }

  async streamChat(message: string, onChunk: (chunk: string) => Promise<void>) {
    this.messages.push({
      role: "user",
      content: message,
    });
    const { textStream, text } = streamText({
      model: this.model,
      messages: this.messages,
    });
    for await (const chunk of textStream) {
      await onChunk(chunk);
    }
    const finalText = await text;
    this.messages.push({
      role: "assistant",
      content: finalText,
    });
    return finalText;
  }

  async saveChat(path: string) {
    const newPath = z
      .string()
      .regex(/^.*\.(json|md)$/)
      .parse(path);
    const extension = newPath.split(".").pop();
    const type = extension === "json" ? "json" : "markdown";
    if (type === "json") {
      await fs.writeFile(path, JSON.stringify(this.messages, null, 2));
    } else {
      await fs.writeFile(
        path,
        this.messages.map((m) => `\n**${m.role}**: \n\n${m.content}`).join("\n")
      );
    }
  }
}

export class VercelAIFileCompletions {
  constructor(
    public readonly model: LanguageModelV1,
    private modelOptions?: VercelAIOptions
  ) {}

  static createFileMessage(
    prompt: string,
    parts: (
      | {
          type: "file";
          file: Uint8Array | ArrayBuffer | Buffer;
          filename: string;
          mimeType: string;
        }
      | { type: "image"; image: Uint8Array | ArrayBuffer | URL }
    )[]
  ): CoreMessage {
    return {
      role: "user",
      content: prompt,
      parts: parts.map((part) => {
        if (part.type === "file") {
          return {
            type: "file",
            data: part.file,
            filename: part.filename,
            mimeType: part.mimeType,
          };
        } else {
          return {
            type: "image",
            image: part.image,
          };
        }
      }),
    } as CoreMessage;
  }

  async generateTextWithFile(message: CoreMessage) {
    const response = await generateText({
      model: this.model,
      messages: [message],
      maxRetries: this.modelOptions?.maxRetries,
    });
    return this.modelOptions
      ? transformResponse(response.text, this.modelOptions)
      : response.text;
  }
}
