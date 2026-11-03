from __future__ import annotations

import unittest

from introspection_harbor.agent import adapter_class
from introspection_harbor.bootstrap_agent import IntrospectionBootstrapAgent
from introspection_harbor.native_agent import IntrospectionNativeAgent
from introspection_harbor.runtime_agent import IntrospectionRecipeAgent


class AdapterSelectionTest(unittest.TestCase):
    def test_default_is_the_baked_image_adapter(self) -> None:
        self.assertIs(adapter_class(""), IntrospectionRecipeAgent)

    def test_each_adapter_is_selectable_by_name(self) -> None:
        self.assertIs(adapter_class("runtime"), IntrospectionRecipeAgent)
        self.assertIs(adapter_class("bootstrap"), IntrospectionBootstrapAgent)
        self.assertIs(adapter_class("native"), IntrospectionNativeAgent)

    def test_unknown_names_fail_with_the_choices(self) -> None:
        with self.assertRaisesRegex(ValueError, "bootstrap, native, runtime"):
            adapter_class("cloud")
