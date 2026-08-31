import { discoverSkills, loadSkill, loadSkillSafe } from './skill-loader.js';
import type { AgentName, Skill } from '../types.js';

const AGENT_SKILL_MAP: Record<AgentName, string> = {
  coder:      'backend-engineer',
  reviewer:   'senior-code-reviewer',
  researcher: 'researcher',
  writer:     'technical-writer',
  general:    'general-assistant',
};

const FALLBACK_SKILL: Record<AgentName, string> = {
  coder:      'You are an expert software engineer. Write clean, efficient, well-documented code.',
  reviewer:   'You are a senior code reviewer. Provide constructive, actionable feedback.',
  researcher: 'You are a technical researcher. Provide accurate, well-sourced explanations.',
  writer:     'You are a technical writer. Write clear, concise documentation.',
  general:    'You are a helpful AI assistant for software development.',
};

const SKILL_NAME_ALIASES: Record<string, string> = {
  coder: 'backend-engineer',
  reviewer: 'senior-code-reviewer',
  researcher: 'researcher',
  writer: 'technical-writer',
  general: 'general-assistant',
};

async function loadDiscoveredSkill(agent: AgentName): Promise<Skill | null> {
  const skills = await discoverSkills();
  const alias = SKILL_NAME_ALIASES[agent];
  const match = skills.find(skill => skill.agent === agent || skill.name === agent || skill.name === alias);
  if (!match) return null;

  return loadSkill(match.path);
}

export async function getSkillForAgent(
  agent: AgentName,
  query?: string,
  framework?: string | null,
  languages?: string[],
): Promise<Skill> {
  if (query) {
    const { findBestSkillForQuery } = await import('./skill-loader.js');
    const dynamicSkill = await findBestSkillForQuery(query, agent, framework, languages);
    if (dynamicSkill) {
      return dynamicSkill;
    }
  }

  const fileName = AGENT_SKILL_MAP[agent];
  const skill = await loadSkillSafe(fileName);

  if (skill) return skill;

  const discovered = await loadDiscoveredSkill(agent);
  if (discovered) return discovered;

  // Graceful fallback — built-in prompt if .md file is missing
  return {
    name:    agent,
    version: '0.0',
    agent,
    content: FALLBACK_SKILL[agent],
  };
}

export { loadSkill };
