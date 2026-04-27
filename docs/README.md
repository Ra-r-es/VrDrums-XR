# Project Documentation

## Building the report

`report.tex` targets a standard LaTeX distribution (TeX Live or MacTeX).
The document uses `article`, `tikz`, `listings`, `hyperref`, `geometry`,
`graphicx`, `amsmath`, and `enumitem` — all of which ship with any
reasonable full install.

```bash
cd docs
pdflatex -interaction=nonstopmode report.tex
pdflatex -interaction=nonstopmode report.tex   # second pass for TOC
```

Or with `latexmk`:

```bash
cd docs
latexmk -pdf report.tex
```

If you don't want to install LaTeX locally, you can upload `report.tex`
to [Overleaf](https://overleaf.com) as a new project — it will compile
out of the box.

## Contents

- `report.tex` — full project report (≈15 pages after compile)
- target output: `report.pdf`
