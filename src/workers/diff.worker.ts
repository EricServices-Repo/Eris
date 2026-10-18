import { lineChanges } from '../shared/line-diff'
self.onmessage = ({ data }: MessageEvent<{ id: number; before: string; after: string }>) => {
  self.postMessage({ id: data.id, changes: lineChanges(data.before, data.after) })
}
