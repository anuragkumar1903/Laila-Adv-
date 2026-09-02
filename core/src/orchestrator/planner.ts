import { chat } from '../llm/provider-factory.js';
import type { LLMMessage } from '../llm/providers/base.js';

export async function generatePlan(goal: string, projectPath: string, projectId: number | null): Promise<string[]> {
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: `You are an expert software architect planning a complex task for an AI assistant.
Break down the following goal into 3-7 discrete, sequential, and actionable steps.
Each step MUST be phrased as a direct instruction that an AI assistant (like yourself) can execute in one go.
Do not provide any explanations, introductory text, or markdown formatting.
Just return a plain text list, one step per line.
Keep the steps focused on modifying files or running commands.`
    },
    {
      role: 'user',
      content: `Goal: ${goal}`
    }
  ];

  const result = await chat(messages, { temperature: 0.2 });
  const lines = result.content
    .split('\n')
    .map(l => l.replace(/^\d+\.\s*/, '').trim()) // remove numbering
    .filter(l => l.length > 5);

  return lines;
}
