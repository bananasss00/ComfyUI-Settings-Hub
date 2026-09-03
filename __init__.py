from .py.settings_hub import SettingsHubNode
from .py import media_list  # noqa: F401  v47: registers /settings_hub/list_media route

NODE_CLASS_MAPPINGS = {
    "SettingsHub": SettingsHubNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SettingsHub": "Settings Hub",
}

WEB_DIRECTORY = "./web"
