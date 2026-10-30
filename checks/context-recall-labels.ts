/** Labeled cases: the expected source must be selected and the distractor must not. */
export const LABELED = [
  {
    name: 'camelCase query finds snake_case source',
    query: 'bookingConfirmation',
    expected: 'Fixed booking_confirmation retry handling',
    distractor: 'Booking page copy is ready for review'
  },
  {
    name: 'snake_case query finds camelCase source',
    query: 'booking_confirmation',
    expected: 'bookingConfirmation now retries twice',
    distractor: 'The confirmation dialog moved to the header'
  },
  {
    name: 'a word does not match inside an unrelated identifier',
    query: 'cat',
    expected: 'The cat feeder schedule changed',
    distractor: 'Call concatenate on the buffers'
  },
  {
    name: 'path query finds the exact file',
    query: 'src/auth/login.ts',
    expected: 'Edited src/auth/login.ts for session expiry',
    distractor: 'Edited src/billing/invoice.ts for rounding'
  },
  {
    name: 'file name query finds a nested path',
    query: 'login.ts',
    expected: 'Edited src/auth/login.ts for session expiry',
    distractor: 'Login copy was approved'
  },
  {
    name: 'a hyphenated query finds the same words split apart',
    query: 'dry-run',
    expected: 'Add a dry run flag to the installer',
    distractor: 'The run finished overnight'
  },
  {
    name: 'Go keeps a two-letter language name',
    query: 'Go',
    expected: 'The ingest worker should be written in Go',
    distractor: 'Please go ahead with the rename'
  },
  {
    name: 'C# keeps its symbol',
    query: 'C#',
    expected: 'The plugin SDK targets C# only',
    distractor: 'Grade C was fine for the audit'
  },
  {
    name: 'C++ is distinct from C#',
    query: 'c++',
    expected: 'The decoder stays in C++',
    distractor: 'The plugin SDK targets C#'
  },
  {
    name: 'Japanese text matches by bigram',
    query: '決済の通貨',
    expected: '決済通貨はカナダドルに決定しました',
    distractor: '天気がとても良いです'
  },
  {
    name: 'Chinese text matches by bigram',
    query: '数据库迁移',
    expected: '我们完成了数据库迁移的计划',
    distractor: '今天的会议取消了'
  },
  {
    name: 'accented Latin folds to its base letters',
    query: 'cafe',
    expected: 'The café menu page shipped',
    distractor: 'The menu page shipped'
  },
  {
    name: 'Cyrillic words are recalled',
    query: 'валюта',
    expected: 'Основная валюта оформления заказа',
    distractor: 'Погода сегодня хорошая'
  },
  {
    name: 'a plural form matches its singular',
    query: 'test',
    expected: 'Both tests failed after the rebase',
    distractor: 'The latest attestation expired'
  }
]
