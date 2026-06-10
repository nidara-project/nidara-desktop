// Robust Polyfill for Array.prototype.flat for GJS compatibility
if (typeof Array.prototype.flat !== 'function') {
    console.log("Array.prototype.flat is missing, applying robust polyfill...");
    Object.defineProperty(Array.prototype, 'flat', {
        configurable: true,
        value: function flat() {
            var depth = isNaN(arguments[0]) ? 1 : Number(arguments[0]);

            return depth ? Array.prototype.reduce.call(this, function (acc, cur) {
                if (Array.isArray(cur)) {
                    acc.push.apply(acc, flat.call(cur, depth - 1));
                } else {
                    acc.push(cur);
                }

                return acc;
            }, []) : Array.prototype.slice.call(this);
        },
        writable: true
    });
    if (typeof Array.prototype.flat === 'function') {
        console.log("Polyfill applied successfully.");
    } else {
        console.log("Failed to apply polyfill!");
    }
} else {
    console.log("Array.prototype.flat already exists.");
}

// Test it immediately
try {
    const test = [[1], [2, [3]]].flat(2);
    console.log("Test flat(2):", JSON.stringify(test));
} catch (e) {
    console.log("Test flat failed:", e.message);
}
