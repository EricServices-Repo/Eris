export type CheckpointReviewStatus = 'pending' | 'kept' | 'undone' | 'conflicted'
export interface CheckpointReviewItem {
  opIndex: number
  status: CheckpointReviewStatus
  reason?: string
}
export interface CheckpointReviewRequest {
  checkpointId: string
  opIndices: number[]
  decision: 'keep' | 'undo'
}
