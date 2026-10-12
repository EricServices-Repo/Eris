import { EventEmitter } from 'events'
import type { CloudJob } from './types.js'

type JobListener = (job: CloudJob) => void

class JobEvents extends EventEmitter {
  emitJob(job: CloudJob): void {
    this.emit(`job:${job.id}`, job)
    this.emit('job', job)
  }

  onJob(id: string, fn: JobListener): () => void {
    const handler = (job: CloudJob) => fn(job)
    this.on(`job:${id}`, handler)
    return () => this.off(`job:${id}`, handler)
  }

  onAnyJob(fn: JobListener): () => void {
    const handler = (job: CloudJob) => fn(job)
    this.on('job', handler)
    return () => this.off('job', handler)
  }
}

export const jobEvents = new JobEvents()
