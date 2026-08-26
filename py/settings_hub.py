class SettingsHubNode:
    CATEGORY = "Settings Hub"
    FUNCTION = "noop"
    RETURN_TYPES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    def noop(self):
        pass
