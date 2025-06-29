import { ChatOllama, ChatOllamaCallOptions } from "npm:@langchain/ollama";
import { ChatPromptTemplate } from "npm:@langchain/core/prompts";
import { tool, DynamicStructuredTool } from "npm:@langchain/core/tools";

export class OllamaLangchain {
  public llm: ChatOllama;

  static createTool = tool;

  constructor(model: string, options: ChatOllamaCallOptions = {}) {
    this.llm = new ChatOllama({
      baseUrl: "http://localhost:11434",
      model: model,
      maxRetries: 0,
      ...options,
    });
  }

  getLLMWithTools(tools: DynamicStructuredTool[]) {
    const toolLLM = this.llm.bindTools(tools);
    return toolLLM;
  }

  async invoke(prompt: string) {
    return await this.llm.invoke(prompt);
  }

  async invokeWithMessages(messageTuples: [string, string][]) {
    return await this.llm.invoke(messageTuples);
  }

  createChain<T extends Record<string, unknown>>(
    messageTuples: [string, string][]
  ) {
    const prompt = ChatPromptTemplate.fromMessages(messageTuples);
    const chain = prompt.pipe(this.llm);
    return {
      chain,
      invokeChain: async (data: T) => {
        return await chain.invoke(data);
      },
    };
  }
}

export class MessageCreator {
  static createMessage(
    role: "user" | "assistant" | "system" | "tool",
    content: string
  ) {
    return [role, content];
  }

  static createSystemMessage(content: string) {
    return this.createMessage("system", content);
  }

  static createUserMessage(content: string) {
    return this.createMessage("user", content);
  }

  static createAssistantMessage(content: string) {
    return this.createMessage("assistant", content);
  }

  static createToolMessage(content: string) {
    return this.createMessage("tool", content);
  }
}
