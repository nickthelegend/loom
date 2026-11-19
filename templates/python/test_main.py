import unittest
from main import greet


class GreetingTests(unittest.TestCase):
    def test_greeting(self):
        self.assertEqual(greet(), "Hello, world!")
        self.assertEqual(greet("Loom"), "Hello, Loom!")


if __name__ == "__main__":
    unittest.main()
