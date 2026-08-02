import path from 'node:path';
import { JsonStore } from './store.js';

// Routering op stabiele ID's (plan §1/§3): forum-channel-ID → canoniek project-ID,
// thread-ID → conversation-ID. Namen zijn presentatie, nooit routering.
export class Router {
  constructor({ stateDir, audit }) {
    this.store = new JsonStore(path.join(stateDir, 'mappings.json'));
    this.audit = audit;
    const data = this.store.load({ projects: [], conversations: {} });
    this.projects = data.projects;
    this.conversations = data.conversations;
  }

  #persist() {
    this.store.save({ projects: this.projects, conversations: this.conversations });
  }

  registerProject({
    projectId,
    name,
    forumChannelId,
    path = null,
    forgeMode = null,
    permissionMode = null,
  }) {
    const clash = this.projects.find(
      (p) => p.forumChannelId === forumChannelId && p.projectId !== projectId,
    );
    if (clash) {
      this.audit?.record('project_mapping_conflict', { projectId, forumChannelId, clash: clash.projectId });
      throw new Error(`forumChannelId ${forumChannelId} is al gekoppeld aan ${clash.projectId}`);
    }
    let project = this.projects.find((p) => p.projectId === projectId);
    if (project) {
      Object.assign(project, {
        name,
        forumChannelId,
        path: path ?? project.path ?? null,
        forgeMode: forgeMode ?? project.forgeMode ?? false,
        permissionMode: permissionMode ?? project.permissionMode ?? 'default',
      });
    } else {
      project = {
        projectId,
        name,
        forumChannelId,
        path,
        forgeMode: forgeMode ?? false,
        // Owner-directief 2026-07-30: "read only off" — nieuwe projecten mogen
        // standaard schrijven; per project uitschakelbaar met /forge write off.
        permissionMode: permissionMode ?? 'acceptEdits',
        archived: false,
      };
      this.projects.push(project);
    }
    this.#persist();
    this.audit?.record('project_registered', { projectId, forumChannelId });
    return project;
  }

  setPermissionMode(projectId, mode) {
    const project = this.projects.find((p) => p.projectId === projectId);
    if (!project) return null;
    project.permissionMode = mode;
    this.#persist();
    this.audit?.record('project_permission_mode_changed', { projectId, mode });
    return project;
  }

  // Model/effort per project instelbaar vanuit Discord.
  setRunOption(projectId, key, value) {
    const project = this.projects.find((p) => p.projectId === projectId);
    if (!project) return null;
    project[key] = value;
    this.#persist();
    this.audit?.record('project_run_option_changed', { projectId, key, value });
    return project;
  }

  archiveProject(projectId) {
    const project = this.projects.find((p) => p.projectId === projectId);
    if (!project) return null;
    project.archived = true;
    this.#persist();
    this.audit?.record('project_archived', { projectId });
    return project;
  }

  reactivateProject(projectId) {
    const project = this.projects.find((p) => p.projectId === projectId);
    if (!project) return null;
    project.archived = false;
    this.#persist();
    this.audit?.record('project_reactivated', { projectId });
    return project;
  }

  projectByChannel(channelId) {
    return this.projects.find((p) => p.forumChannelId === channelId) ?? null;
  }

  // channelId = parent-forumkanaal van de thread. Onbekend kanaal → null (negeren).
  // Een thread die al aan een ANDER project hangt → route_conflict (nooit cross-routeren).
  resolveRoute({ channelId, threadId }) {
    const project = this.projectByChannel(channelId);
    if (!project) {
      this.audit?.record('unregistered_channel_ignored', { channelId, threadId });
      return null;
    }
    if (project.archived) {
      this.audit?.record('archived_project_blocked', { projectId: project.projectId, threadId });
      return { projectId: project.projectId, archived: true, conversationId: null };
    }
    let conv = this.conversations[threadId];
    if (conv && conv.projectId !== project.projectId) {
      this.audit?.record('route_conflict', {
        threadId,
        expectedProject: conv.projectId,
        actualProject: project.projectId,
      });
      return null;
    }
    if (!conv) {
      conv = { conversationId: `conv_${threadId}`, projectId: project.projectId, threadId };
      this.conversations[threadId] = conv;
      this.#persist();
      this.audit?.record('conversation_registered', {
        threadId,
        conversationId: conv.conversationId,
        projectId: project.projectId,
      });
    }
    return { projectId: project.projectId, conversationId: conv.conversationId, archived: false };
  }
}
