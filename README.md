# `@karimsa/bench`

Minimal benchmarking library for JS. Extracted from `@karimsa/wiz`.

## Usage

Sample benchmark file

```javascript
const { benchmark } = require('@karimsa/bench')

benchmark('test', async b => {
    // do setup
    b.resetTimer()

    for (let i = 0; i < b.N(); i++) {
        // do expensive op
        await foo()
    }
})
```

Run it like a regular node program:

```
$ node bench.js
```

## License

Licensed under MIT.

