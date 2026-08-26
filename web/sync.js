// Synchronous function registry to avoid circular imports
let _syncHubNode = null;
export function registerSync(fn) {
    _syncHubNode = fn;
}

export function syncNode(node) {
    if (_syncHubNode) _syncHubNode(node);
}
