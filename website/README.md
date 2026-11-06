# Eris documentation site

The site renders the repository's Markdown in `docs/` directly, including Mermaid diagrams. Edit the source guides there. Docusaurus writes the production HTML and assets to `website/build/`.

From the repository root, use Node.js 22 and run:

```sh
npm ci --prefix website
npm run start --prefix website
npm run build --prefix website
npm run serve --prefix website
```

Use `start` for editing and `serve` to preview the production build. Open the local server at `/Eris/`.

The [documentation workflow](../.github/workflows/static.yml) checks relevant pull requests and publishes after pushes to `main`, including PR merges. It uploads only the generated site. GitHub Pages uses **GitHub Actions** as its source in the repository settings. The expected site is [Eris Documentation](https://ericservices-repo.github.io/Eris/).
