import { registerImageIpc } from './images'
import { registerWorkspaceIpc } from './workspace'
import { registerAppIpc } from './app'
import { registerSettingsIpc } from './settings'
import { registerModelsIpc } from './models'
import { registerOllamaIpc } from './ollama'
import { registerChatsIpc } from './chats'
import { registerAgentsIpc } from './agents'
import { registerChatStreamIpc } from './chat-stream'
import { registerCheckpointsIpc } from './checkpoints'
import { registerTerminalIpc } from './terminal'
import { registerLspIpc } from './lsp'
import { registerGitIpc } from './git'
import { registerGithubIpc } from './github'
import { registerEricServicesIpc } from './ericservices'
import { registerMcpIpc } from './mcp'
import { registerSearchIpc } from './search'
import { registerAiIpc } from './ai'
import { registerDebugIpc } from './debug'
import { registerContextIpc } from './context'
import { registerEvalsIpc } from './evals'
import { registerBackgroundAgentsIpc } from './background-agents'
import { registerCloudAgentsIpc } from './cloud-agents'
import { registerUpdatesIpc } from './updates'
import { registerBugReportIpc } from './bug-report'

export function registerIpc(): void {
  registerImageIpc()
  registerWorkspaceIpc()
  registerAppIpc()
  registerSettingsIpc()
  registerModelsIpc()
  registerOllamaIpc()
  registerChatsIpc()
  registerAgentsIpc()
  registerChatStreamIpc()
  registerCheckpointsIpc()
  registerTerminalIpc()
  registerLspIpc()
  registerGitIpc()
  registerGithubIpc()
  registerEricServicesIpc()
  registerMcpIpc()
  registerSearchIpc()
  registerAiIpc()
  registerDebugIpc()
  registerContextIpc()
  registerEvalsIpc()
  registerBackgroundAgentsIpc()
  registerCloudAgentsIpc()
  registerUpdatesIpc()
  registerBugReportIpc()
}
