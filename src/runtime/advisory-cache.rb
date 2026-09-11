# Consume a protected, freshly fetched npm advisory response. Removing this shim
# cannot open network access: the worker's native OS boundary remains in force.
require "bundler/setup"
require "json"
require "net/http"

module OpenCorpAdvisoryCache
  def post(uri, data, headers = nil)
    if uri.to_s == "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk"
      cache = JSON.parse(File.read(ENV.fetch("OPENCORP_NPM_AUDIT_CACHE")))
      query = JSON.parse(data)
      unless query == cache.fetch("query") && Time.now.to_i - cache.fetch("fetchedAtEpoch") <= 3600
        raise "OpenCorp advisory cache is stale or the importmap changed; refresh through dependency preparation"
      end
      response = Net::HTTPResponse::CODE_TO_OBJ.fetch(cache.fetch("status").to_s).new("1.1", cache.fetch("status").to_s, "Public npm advisory response")
      response["content-type"] = "application/json"
      response.body = cache.fetch("body")
      response.instance_variable_set(:@read, true)
      response
    else
      super
    end
  end
end
Net::HTTP.singleton_class.prepend(OpenCorpAdvisoryCache)

# Preserve Brakeman's stock ensure-latest decision, including its failure when
# the locked scanner is outdated. Only the public metadata transport changes.
module OpenCorpBrakemanRelease
  def latest_spec_for(name)
    return super unless name == "brakeman"
    require "date"
    cache = JSON.parse(File.read(ENV.fetch("OPENCORP_BRAKEMAN_RELEASE_CACHE")))
    raise "OpenCorp Brakeman release cache is stale; refresh dependency preparation" if Time.now.to_i - cache.fetch("fetchedAtEpoch") > 3600
    release = cache.fetch("releases").max_by { |item| Gem::Version.new(item.fetch("number")) }
    Gem::Specification.new do |spec|
      spec.name = name
      spec.version = release.fetch("number")
      spec.date = Date.parse(release.fetch("built_at"))
    end
  end
end
Gem.singleton_class.prepend(OpenCorpBrakemanRelease)

if File.basename($PROGRAM_NAME) == "rubocop"
  require "rubocop"
  # A CI checkout has no product configuration in the Owner's or other
  # products' directories. Preserve every source/config inside this checkout.
  module OpenCorpRuboCopRoot
    def traverse_directories_upwards(start_dir, stop_dir = nil)
      root = File.realpath(ENV.fetch("OPENCORP_PRODUCT_ROOT"))
      super(start_dir, stop_dir) do |directory|
        path = File.expand_path(directory)
        break unless path == root || path.start_with?(root + File::SEPARATOR)
        yield directory
      end
    end
  end
  RuboCop::Config.prepend(OpenCorpRuboCopRoot)
end
