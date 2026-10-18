import { describe, expect, it } from 'vitest'
import {
  answerGroundedIn,
  extractiveWebAnswer,
  firstHttpsResult,
  replyFromWebEvidence,
  unsupportedProperNames,
  webSearchQuery
} from '../electron/main/services/agent/web-grounding'

const HITS = `Searched the web for “Steve Embling”.

1. Steve Embling — Example Telecom
   https://example.com/people/steve-embling
   Engineer at Example Telecom in Ohio.
`

const PAGE = `Opened https://example.com/people/steve-embling
Title: Steve Embling — Example Telecom

Steve Embling is an engineer at Example Telecom in Ohio.`

const HALLUCINATION =
  'Steve Embling is a well-known American actor, comedian, and singer. He is often associated with the comedy series "The Colbert Report" and has appeared in several films. Steve Embling has been nominated for multiple awards, including an Academy Award for Best Actor and a Golden Globe for Best Actor in a Comedy Series. He is also known for his role as the father in the TV series "The Office".'

describe('webSearchQuery', () => {
  it('uses the person named in a who-is question', () => {
    expect(webSearchQuery('Review the internet, who is Steve Embling')).toBe('Steve Embling')
    expect(webSearchQuery('who is Ada Lovelace?')).toBe('Ada Lovelace')
  })
})

describe('firstHttpsResult', () => {
  it('returns the first result and skips the search engine', () => {
    expect(firstHttpsResult(`${HITS}\nhttps://duckduckgo.com/html`)).toBe(
      'https://example.com/people/steve-embling'
    )
    expect(firstHttpsResult('Searched the web for “Steve Embling”.\n\nNo results.')).toBeNull()
  })
})

describe('replyFromWebEvidence', () => {
  it('rejects a biography that the sources never mention', () => {
    expect(unsupportedProperNames(HALLUCINATION, `${HITS}\n${PAGE}`, 'Steve Embling')).toEqual(
      expect.arrayContaining(['The Colbert Report', 'Academy Award', 'Best Actor', 'Golden Globe', 'The Office'])
    )
    expect(answerGroundedIn(HALLUCINATION, `${HITS}\n${PAGE}`, 'Steve Embling')).toBe(false)
    const reply = replyFromWebEvidence(HALLUCINATION, 'Steve Embling', HITS, PAGE)
    expect(reply).toContain('https://example.com/people/steve-embling')
    expect(reply).toContain('Example Telecom')
    expect(reply).not.toMatch(/Colbert|The Office|Academy Award/)
  })

  it('keeps a reply that only repeats the page', () => {
    const grounded = 'Steve Embling is an engineer at Example Telecom in Ohio. https://example.com/people/steve-embling'
    expect(replyFromWebEvidence(grounded, 'Steve Embling', HITS, PAGE)).toBe(grounded)
  })

  it('says when the search found nothing', () => {
    const empty = 'Searched the web for “Steve Embling”.\n\nNo results.'
    expect(extractiveWebAnswer('Steve Embling', empty, '')).toBe(
      'I searched the web for “Steve Embling” and did not find a public page.'
    )
  })
})
