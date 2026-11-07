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
  stylesheets: [
    'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap'
  ],
  themes: ['@docusaurus/theme-mermaid'],
  presets: [
    [
      'classic',
      {
        blog: false,
        theme: { customCss: './src/css/custom.css' },
        docs: {
          path: '../docs',
          routeBasePath: '/',
          sidebarPath: './sidebars.mjs',
          beforeDefaultRemarkPlugins: [repositoryLinks],
          editUrl: ({ docPath }) => `${repository}/edit/main/docs/${docPath}`
        }
      }
    ]
  ],
  themeConfig: {
    docs: { sidebar: { autoCollapseCategories: true } },
    colorMode: { respectPrefersColorScheme: true },
    navbar: {
      title: 'Eris Docs',
      items: [
        { to: '/guides/', label: 'Guides', position: 'left' },
        { to: '/ARCHITECTURE/', label: 'Architecture', position: 'left' },
        { to: '/ERIS-DEV/', label: 'Eris-Dev', position: 'left' },
        { href: repository, label: 'GitHub', position: 'right' }
      ]
    },
    footer: {
      links: [
        {
          title: 'Documentation',
          items: [
            { label: 'Guide index', to: '/guides/' },
            { label: 'Using Eris', to: '/ERIS_USAGE/' }
          ]
        },
        {
          title: 'Project',
          items: [
            { label: 'EricServic.es', href: 'https://www.ericservic.es/products/eris.php' },
            { label: 'Source code', href: repository },
            { label: 'Releases', href: `${repository}/releases` }
          ]
        }
      ]
    }
  }
}
