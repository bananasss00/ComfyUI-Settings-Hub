from .py.settings_hub import SettingsHubNode
from .py import media_list  # noqa: F401  v47: registers /settings_hub/list_media route
from .py import stack_store  # noqa: F401  v70: registers /settings_hub/stack* routes (Paste Stack storage)
from .py import clipboard_helper  # noqa: F401  v71: registers /settings_hub/clipboard (OS-clipboard read for the stack, loopback + custom header)

NODE_CLASS_MAPPINGS = {
    "SettingsHub": SettingsHubNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SettingsHub": "Settings Hub",
}

WEB_DIRECTORY = "./web"
