package plugincontract

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// Workspace plugins kept in this fork (plugins/*) must pass the same
// validation an upload does, so a manifest or bundle the host would refuse is
// caught here rather than in Settings → Plugins.
func TestForkWorkspacePluginsParseAsBundles(t *testing.T) {
	for _, name := range []string{"jiaowu-review"} {
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join("..", "..", "..", "plugins", name)
			bundle, err := ParseBundleFromDir(func(entry string) ([]byte, bool, error) {
				content, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(entry)))
				if errors.Is(err, fs.ErrNotExist) {
					return nil, false, nil
				}
				return content, err == nil, err
			})
			if err != nil {
				t.Fatalf("ParseBundleFromDir: %v", err)
			}
			if len(bundle.Manifest.Contributes.CardButtons) == 0 || len(bundle.Manifest.Contributes.Hooks) == 0 {
				t.Fatalf("manifest lost its contributions: %+v", bundle.Manifest.Contributes)
			}
		})
	}
}
