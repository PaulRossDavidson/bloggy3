BloggyApp.controller('PostShowCtrl', ['$scope','Post', '$routeParams', function($scope, Post, $routeParams){

  $scope.post={};

  Post.get({id: $routeParams.id}).then(function(post){
    console.log(post);
    $scope.post = post;
  });


}]);
