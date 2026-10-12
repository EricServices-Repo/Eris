import { ipcMain } from 'electron'
import {
  buildBugReportPreview,
  submitBugReport,
  type BugReportInput
} from '../services/bug-report'

export function registerBugReportIpc(): void {
  ipcMain.handle('bugReport:preview', (_e, input: BugReportInput) => buildBugReportPreview(input))
  ipcMain.handle('bugReport:submit', (_e, input: BugReportInput) => submitBugReport(input))
}
