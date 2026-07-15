import { findAll } from '../memory/repositories/projects.js';
import { createSession, findLatestActiveSession } from '../memory/repositories/sessions.js';

export interface ResolvedWorkspace {
  sessionId: number;
  projectId: number | null;
  isTemporarySession: boolean;
}

export function resolveWorkspace(): ResolvedWorkspace {
  const activeSession = findLatestActiveSession();
  if (activeSession) {
    return {
      sessionId: activeSession.id,
      projectId: activeSession.project_id,
      isTemporarySession: false,
    };
  }

  const projects = findAll();
  const projectId = projects[0]?.id ?? null;
  const session = createSession(projectId);

  return {
    sessionId: session.id,
    projectId,
    isTemporarySession: true,
  };
}