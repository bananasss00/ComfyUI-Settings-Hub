class SettingsHubNode:
    """Backend stub: all logic lives in web/*.js.

    The node MUST NOT be an execution endpoint: OUTPUT_NODE is intentionally
    absent so the prompt executor never schedules it during queueing
    (RETURN_TYPES = () -> nothing can depend on it). noop() returns an empty
    tuple as belt-and-braces: returning None here crashed merge_result_data
    ("object of type 'NoneType' has no len()") whenever the stub WAS executed,
    e.g. by bypass/re-run paths of older frontends.
    """

    CATEGORY = "Settings Hub"
    FUNCTION = "noop"
    RETURN_TYPES = ()

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    def noop(self):
        return ()
