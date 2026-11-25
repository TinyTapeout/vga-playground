# Tiny Tapeout VGA Playground

Online version: https://vga-playground.com/

Write and run verilog code to generate VGA signals in the browser, then manufacture your project with [Tiny Tapeout](https://tinytapeout.com/).

## Development

You'll need to have [Node.js](https://nodejs.org) installed on your computer and clone this repository.

Then you can install the dependencies and run the development server:

```bash
npm install
npm start
```

To view the playground, open `http://localhost:5173` in your browser.

## URL Parameters

You can use URL parameters to load a specific preset or a project from GitHub:

### Load a preset

    https://vga-playground.com/?preset=music

Available presets: `stripes`, `music`, `rings`, `logo`, `conway`, `checkers`, `drop`, `gamepad`

### Load a project from GitHub

    https://vga-playground.com/?repo=https://github.com/urish/tt-rings

This fetches `info.yaml` from the repository to discover source files, then loads them into the editor. The repository must follow the [Tiny Tapeout](https://tinytapeout.com/) project structure.

Optionally, specify a git ref (branch, tag, or commit hash) to load a specific version:

    https://vga-playground.com/?repo=https://github.com/urish/tt-rings&ref=main

If `ref` is not specified, defaults to `main` (then `master`).

## Embedding

Add `embed` to the URL (e.g. `https://vga-playground.com/?embed`) to show only the display and its input and
audio controls, for use in an `<iframe>`. Nothing runs until the parent window loads a design:

```js
iframe.contentWindow.postMessage(
  {
    type: 'vga-playground:load',
    id: 1, // optional: returned in the reply
    files: { 'project.v': '...', 'hvsync_generator.v': '...' }, // file name -> source
    dataFiles: { 'image.hex': '...' }, // optional: files read by $readmemh/$readmemb
  },
  '*',
);
```

The playground compiles and runs the design, then replies with
`{ type: 'vga-playground:loaded', id, ok, errors }`, where `ok` is `false` if compilation or simulation setup
failed, and `errors` lists Verilator's errors and warnings (`{ type, file, line, column, message }`). It
posts `{ type: 'vga-playground:ready' }` to its parent once it accepts `load` messages. As in the editor,
`.vh` and `.svh` files are only `include`d; every other file is compiled.
