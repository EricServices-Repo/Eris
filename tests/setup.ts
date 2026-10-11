import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

process.env.ERIS_TEST_APPDATA = mkdtempSync(join(tmpdir(), 'eris-test-'))
