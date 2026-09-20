# Loom Desktop, for people who install Mac apps with Homebrew.
#
# This lives in Loom's own repository rather than homebrew-cask, and it has to:
# the official tap requires every cask to be signed and notarized by Apple, and
# Loom's macOS build is ad-hoc signed because the project has no Developer ID.
# (There is no free one. Apple's fee waiver is for nonprofits, schools and
# government entities, and a free Apple ID cannot sign for distribution at all.)
#
#   brew tap nickthelegend/loom https://github.com/nickthelegend/loom
#   brew install --cask loom-desktop
#   brew upgrade --cask loom-desktop
#
# What this does NOT do is get past Gatekeeper. Homebrew applies the quarantine
# attribute to cask downloads on purpose, and removed the flag that used to
# skip it — so the first launch of an unsigned app asks, exactly as it does for
# a dmg you downloaded yourself: right-click the app, Open, Open. Some taps run
# `xattr -dr com.apple.quarantine` in a postflight to avoid that. This one
# doesn't: quarantine is the protection that exists *because* the app is
# unsigned, and turning it off on your behalf is not a thing an install command
# should do quietly.
#
# What it does buy is a one-line install and `brew upgrade --cask` as a real
# update path, owned by the package manager you already trust.
cask "loom-desktop" do
  arch arm: "arm64", intel: "x64"

  version "0.2.4"
  sha256 arm:   "636febb3f160d316b9c1186eb65807f644c110b5d8a11ab98fd9f2e8d6937b6d",
         intel: "46c23d5eb4ed3dcc5e065daec653d25fa19d5dea669d55b5fcf4cfd2d0ccea3e"

  url "https://github.com/nickthelegend/loom/releases/download/v#{version}/Loom-Desktop-#{version}-#{arch}.dmg"
  name "Loom Desktop"
  desc "Continuity layer for a fleet of coding agents"
  homepage "https://github.com/nickthelegend/loom"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Not true, and saying it would be worse than saying nothing: `auto_updates`
  # tells brew the app replaces itself, and brew then skips it on upgrade
  # unless you pass --greedy. Loom's macOS build can't replace itself, which is
  # the whole reason this cask is useful.
  # auto_updates true

  app "Loom Desktop.app"

  zap trash: [
    "~/Library/Application Support/Loom Desktop",
    "~/Library/Logs/Loom Desktop",
    "~/Library/Preferences/dev.loom.desktop.plist",
    "~/Library/Saved Application State/dev.loom.desktop.savedState",
  ]
end
