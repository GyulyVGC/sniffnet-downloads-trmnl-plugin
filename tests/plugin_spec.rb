# frozen_string_literal: true

# This plugin's tests, run with `trmnlp test` (add `--report report` for a page of every screen it drew).
# Docs: https://github.com/usetrmnl/trmnlp#testing-plugins
RSpec.describe 'Sniffnet Downloads' do
  # Canned answers for the requests the plugin makes, its polling urls and its transform's own, e.g.
  #   { 'https://api.example.com/*' => { json: { temperature: 21 } } }
  let(:mocks) do
    {
      'https://api.github.com/repos/gyulyvgc/sniffnet/releases?per_page=100' => {
        json: [
          {
            assets: [
              { name: 'Sniffnet_Windows_x64.msi', download_count: 100 },
              { name: 'Sniffnet_macOS_AppleSilicon.dmg', download_count: 50 },
              { name: 'Sniffnet_LinuxDEB_amd64.deb', download_count: 25 }
            ]
          }
        ]
      },
      'https://crates.io/api/v1/crates/sniffnet' => {
        json: { crate: { downloads: 40 } }
      },
      'https://github.com/Homebrew/homebrew-core/pkgs/container/core%2Fsniffnet' => {
        body: '<span>Total downloads</span><h3 title="20">20</h3>',
        content_type: 'text/html'
      },
      'https://github.com/gyulyvgc/sniffnet/pkgs/container/sniffnet' => {
        body: '<span>Total downloads</span><h3 title="10">10</h3>',
        content_type: 'text/html'
      }
    }
  end

  # The values of the custom fields in src/settings.yml to test with.
  let(:custom_fields) { { github_token: '' } }

  # Every view on TRMNL's devices, a failing API and every select option, checked for page errors and leaked values.
  it_behaves_like 'a publishable recipe'

  # A picture of the full view, compared pixel for pixel on every run. Record it once with
  # `trmnlp test --update` (or the workflow's update_snapshots run) and commit tests/snapshots.
  #
  # it 'looks as it did' do
  #   expect(trmnl.render(mocks:, custom_fields:)).to match_snapshot
  # end
end
