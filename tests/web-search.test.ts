import { describe, expect, it } from 'vitest'
import {
  formatOpenedPage,
  formatSearchHits,
  publicHttpsUrl,
  searchPageUrl,
  unwrapDuckDuckGoUrl
} from '../electron/main/services/web-search'

describe('web search', () => {
  it('builds a browser search address from the query', () => {
    expect(searchPageUrl('eris desktop')).toBe(
      'https://html.duckduckgo.com/html/?q=eris%20desktop'
    )
  })

  it('unwraps DuckDuckGo result links', () => {
    expect(
      unwrapDuckDuckGoUrl(
        'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2FEricServices-Repo%2FEris'
      )
    ).toBe('https://github.com/EricServices-Repo/Eris')
  })

  it('allows public https pages and blocks local addresses', () => {
    expect(publicHttpsUrl('https://example.com/docs')).toBe('https://example.com/docs')
    expect(() => publicHttpsUrl('http://example.com')).toThrow(/https/)
    expect(() => publicHttpsUrl('https://localhost/admin')).toThrow(/private|Local/)
    expect(() => publicHttpsUrl('https://192.168.1.2/')).toThrow(/private|Local/)
    expect(() => publicHttpsUrl('file:///etc/passwd')).toThrow(/https/)
  })

  it('formats browser results for the agent', () => {
    const text = formatSearchHits('electron updater', [
      {
        title: 'Eris releases',
        url: 'https://github.com/EricServices-Repo/Eris/releases',
        snippet: 'Desktop installers'
      }
    ])
    expect(text).toContain('Searched the web for “electron updater”')
    expect(text).toContain('https://github.com/EricServices-Repo/Eris/releases')
    expect(formatOpenedPage('https://example.com', 'Example', 'Hello')).toContain('Title: Example')
  })
})
