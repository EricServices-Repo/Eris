import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const repository = 'https://github.com/EricServices-Repo/Eris'
const root = fileURLToPath(new URL('../', import.meta.url))
const docs = resolve(root, 'docs')

// Keep documentation links local. Source and fixture links point to GitHub.
function repositoryLinks() {
  return (tree, file) => {
    const directory = dirname(file.path)

    function visit(node) {
      if (
        ['link', 'definition'].includes(node.type) &&
        node.url &&
        !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(node.url)
      ) {
        const [path, fragment] = node.url.split('#', 2)
        const target = resolve(directory, decodeURI(path))
        const fromRoot = relative(root, target)
        const fromDocs = relative(docs, target)
        const isDocument = !fromDocs.startsWith('..' + sep) && /\.mdx?$/i.test(target)
        if (fromRoot !== '..' && !fromRoot.startsWith('..' + sep) && !isDocument) {
          const encoded = fromRoot.split(sep).map(encodeURIComponent).join('/')
          node.url = `${repository}/blob/main/${encoded}${fragment ? '#' + fragment : ''}`
        }
      }
      node.children?.forEach(visit)
    }

    visit(tree)
  }
}

export default {
  title: 'Eris Documentation',
  url: 'https://ericservices-repo.github.io',
  baseUrl: '/Eris/',
  trailingSlash: true,
  onBrokenLinks: 'throw',
  markdown: { format: 'detect', mermaid: true },
  themes: ['@docusaurus/theme-mermaid'],
  presets: [
    [
      'classic',
      {
        blog: false,
        docs: {
          path: '../docs',
          routeBasePath: '/',
          beforeDefaultRemarkPlugins: [repositoryLinks],
          editUrl: ({ docPath }) => `${repository}/edit/main/docs/${docPath}`
        }
      }
    ]
  ],
  themeConfig: {
    navbar: {
      title: 'Eris Documentation',
      items: [{ href: repository, label: 'GitHub', position: 'right' }]
    }
  }
}
